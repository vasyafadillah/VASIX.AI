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
  "menerjemahkan, belajar, coding, ide bisnis, dan lainnya. " +
  "Jawab dalam bahasa Indonesia kecuali pengguna memakai bahasa lain. Jelas, ringkas, dan jujur. Jika tidak yakin, katakan tidak yakin.\n\n" +
  "CARA MENANGANI FOTO: Kamu bisa melihat foto yang diunggah. Baca semua tulisan di foto dengan teliti. " +
  "Jika foto berisi soal, tugas, atau pertanyaan (soal ujian, PR, latihan, diagram, kode), langsung kerjakan dan jawab " +
  "setiap soalnya satu per satu sesuai nomor, lengkap dengan penjelasan singkat dan langkah-langkahnya supaya pengguna paham, " +
  "tanpa menunggu diminta lagi. Jika foto berisi benda, tempat, dokumen, atau tulisan, jelaskan isinya dan bantu sesuai " +
  "permintaan pengguna. Jika ada bagian foto yang buram atau tidak terbaca, sebutkan bagian mana dan minta foto yang lebih jelas.\n\n" +
  "Selalu beri jawaban lengkap, jangan hanya bertanya balik kalau informasinya sudah ada di foto atau pesan.";

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
          max_tokens: 4000,
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

    // Tahan dulu sampai ada teks jawaban pertama. Kalau stream selesai tanpa teks
    // (misal model "berpikir" sampai kehabisan token, atau error di tengah stream), pindah provider.
    const reader = upstream.body.getReader();
    const dec = new TextDecoder();
    const held = [];
    let buf = "";
    let gotText = false;
    let streamErr = "";
    let finished = false;
    try {
      while (!gotText && !finished) {
        const { done, value } = await reader.read();
        if (done) { finished = true; break; }
        held.push(Buffer.from(value));
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          const j = safeParse(data);
          if (j?.error) streamErr = String(j.error.message || j.error).slice(0, 160);
          if (j?.choices?.[0]?.delta?.content) { gotText = true; break; }
        }
      }
    } catch (e) {
      // putus sebelum ada jawaban
    }

    if (!gotText) {
      try { await reader.cancel(); } catch {}
      errors.push(p.name + ": jawaban kosong" + (streamErr ? " (" + streamErr + ")" : ""));
      coolUntil.set(p.name, Date.now() + 30_000);
      continue; // coba provider berikutnya
    }

    // Berhasil: teruskan stream ke browser
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("X-AI-Provider", p.name);
    for (const chunk of held) res.write(chunk);
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
