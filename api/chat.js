// Server kecil (Vercel Serverless Function) dengan AUTO-FAILOVER antar provider AI gratis.
// Urutan: Gemini -> Groq -> OpenRouter -> (OpenAI, kalau kamu isi kuncinya).
// Kalau satu provider kena limit / error, otomatis pindah ke berikutnya.
//
// Environment variable di Vercel (isi minimal SATU kunci; makin banyak makin awet):
//   GEMINI_API_KEY      kunci gratis dari aistudio.google.com/apikey
//   GROQ_API_KEY        kunci gratis dari console.groq.com
//   OPENROUTER_API_KEY  kunci gratis dari openrouter.ai
//   OPENAI_API_KEY      (opsional, berbayar) dipakai paling akhir kalau semua gratisan habis
//   APP_PASSWORD        (disarankan) sandi akses, supaya orang asing tidak menghabiskan kuota Anda
//
// Opsional, kalau nama model gratis berubah (sering terjadi), ganti tanpa edit kode:
//   GEMINI_MODEL, GROQ_MODEL, GROQ_VISION_MODEL, OPENROUTER_MODEL, OPENROUTER_VISION_MODEL, OPENAI_MODEL

const SYSTEM_PROMPT =
  "Kamu VASIX.AI, asisten AI serbaguna yang membantu pengguna dalam banyak hal: menjawab pertanyaan, menulis, " +
  "menerjemahkan, belajar, coding, ide bisnis, dan lainnya. Kamu juga bisa melihat dan menganalisis foto yang diunggah pengguna. " +
  "Jawab dalam bahasa Indonesia kecuali pengguna " +
  "memakai bahasa lain. Jelas, ringkas, dan jujur. Jika tidak yakin, katakan tidak yakin.";

// Batas foto supaya kuota dan ukuran request terkendali (Vercel membatasi body sekitar 4,5 MB)
const MAX_IMAGES_PER_MSG = 3;
const MAX_IMAGE_CHARS = 1_800_000;   // panjang data URL per foto
const KEEP_IMAGES_IN_LAST = 3;       // hanya pesan-pesan terakhir yang masih mengirim fotonya

const CONNECT_TIMEOUT_MS = 12_000;   // tunggu maksimal segini sampai provider mulai menjawab
const COOLDOWN_MS = 60_000;          // provider yang kena limit dilewati dulu selama ini

// Daftar provider, urut dari prioritas tertinggi. Semuanya memakai format OpenAI.
const PROVIDERS = [
  {
    name: "gemini",
    key: () => process.env.GEMINI_API_KEY,
    url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    model: () => process.env.GEMINI_MODEL || "gemini-2.5-flash",
    visionModel: () => process.env.GEMINI_MODEL || "gemini-2.5-flash",
  },
  {
    name: "groq",
    key: () => process.env.GROQ_API_KEY,
    url: "https://api.groq.com/openai/v1/chat/completions",
    model: () => process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
    visionModel: () => process.env.GROQ_VISION_MODEL || "meta-llama/llama-4-scout-17b-16e-instruct",
  },
  {
    name: "openrouter",
    key: () => process.env.OPENROUTER_API_KEY,
    url: "https://openrouter.ai/api/v1/chat/completions",
    model: () => process.env.OPENROUTER_MODEL || "openrouter/free",
    visionModel: () => process.env.OPENROUTER_VISION_MODEL || "openrouter/free",
  },
  {
    name: "openai",
    key: () => process.env.OPENAI_API_KEY,
    url: "https://api.openai.com/v1/chat/completions",
    model: () => process.env.OPENAI_MODEL || "gpt-4o-mini",
    visionModel: () => process.env.OPENAI_MODEL || "gpt-4o-mini",
  },
];

// Ingatan sementara: provider mana yang sedang "istirahat" karena kena limit.
// (Hanya berlaku selama instance server masih hidup; tidak masalah kalau hilang.)
const coolUntil = new Map();

const isImage = (s) =>
  typeof s === "string" && s.length <= MAX_IMAGE_CHARS && /^data:image\/(jpeg|png|webp|gif);base64,/.test(s);

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Gunakan POST." });
    return;
  }

  const active = PROVIDERS.filter((p) => p.key());
  if (!active.length) {
    res.status(500).json({
      error: "Belum ada kunci AI di server. Isi minimal satu: GEMINI_API_KEY, GROQ_API_KEY, atau OPENROUTER_API_KEY.",
    });
    return;
  }

  const password = process.env.APP_PASSWORD;
  if (password && req.headers["x-app-password"] !== password) {
    res.status(401).json({ error: "Sandi salah." });
    return;
  }

  const body = typeof req.body === "string" ? safeParse(req.body) : req.body;
  const incoming = Array.isArray(body?.messages) ? body.messages : null;
  if (!incoming) {
    res.status(400).json({ error: "Format pesan tidak valid." });
    return;
  }

  // Batasi ukuran supaya kuota terkendali
  const cleaned = incoming
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-30)
    .map((m) => ({
      role: m.role,
      content: m.content.slice(0, 8000),
      images: m.role === "user" && Array.isArray(m.images)
        ? m.images.filter(isImage).slice(0, MAX_IMAGES_PER_MSG)
        : [],
    }));

  // Foto hanya dikirim ulang untuk beberapa pesan terakhir; yang lebih lama jadi teks penanda
  let withImages = 0;
  for (let i = cleaned.length - 1; i >= 0; i--) {
    if (!cleaned[i].images.length) continue;
    if (withImages < KEEP_IMAGES_IN_LAST) withImages++;
    else {
      cleaned[i].content += (cleaned[i].content ? "\n" : "") + "[pengguna mengirim " + cleaned[i].images.length + " foto sebelumnya]";
      cleaned[i].images = [];
    }
  }

  const hasImages = cleaned.some((m) => m.images.length);

  const messages = cleaned
    .filter((m) => m.content.trim() || m.images.length)
    .map((m) => {
      if (!m.images.length) return { role: m.role, content: m.content };
      return {
        role: m.role,
        content: [
          { type: "text", text: m.content.trim() || "Tolong lihat foto ini dan jelaskan isinya." },
          ...m.images.map((url) => ({ type: "image_url", image_url: { url, detail: "auto" } })),
        ],
      };
    });

  if (!messages.length) {
    res.status(400).json({ error: "Pesan kosong." });
    return;
  }

  // Provider yang sedang istirahat ditaruh paling belakang (tetap dicoba kalau semuanya habis)
  const now = Date.now();
  const ready = active.filter((p) => (coolUntil.get(p.name) || 0) <= now);
  const resting = active.filter((p) => (coolUntil.get(p.name) || 0) > now);
  const order = [...ready, ...resting];

  const errors = [];
  for (const p of order) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), CONNECT_TIMEOUT_MS);
    let upstream;
    try {
      upstream = await fetch(p.url, {
        method: "POST",
        signal: ctrl.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + p.key(),
        },
        body: JSON.stringify({
          model: hasImages ? p.visionModel() : p.model(),
          stream: true,
          max_tokens: 1200,
          messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
        }),
      });
    } catch (e) {
      clearTimeout(timer);
      errors.push(p.name + ": tidak bisa terhubung");
      coolUntil.set(p.name, Date.now() + 15_000);
      continue; // coba provider berikutnya
    }
    clearTimeout(timer);

    if (!upstream.ok || !upstream.body) {
      let detail = "";
      try { detail = (await upstream.json())?.error?.message || ""; } catch {}
      errors.push(p.name + " (" + upstream.status + ") " + String(detail).slice(0, 160));
      // 429 = kena limit, 5xx = server mereka error, 401/403 = kunci salah, 404/400 = model tidak ada/ditolak
      // Apa pun alasannya, pindah ke provider lain.
      coolUntil.set(p.name, Date.now() + (upstream.status === 429 ? COOLDOWN_MS : 30_000));
      continue;
    }

    // Berhasil: teruskan stream ke browser
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("X-AI-Provider", p.name);

    const reader = upstream.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
    } catch (e) {
      // koneksi putus, abaikan
    }
    res.end();
    return;
  }

  res.status(503).json({
    error: "Semua provider AI sedang penuh atau error. Coba lagi sebentar lagi. [" + errors.join(" | ") + "]",
  });
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}
