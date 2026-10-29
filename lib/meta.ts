// Minimal Meta Model API client for DapurStudio.
//
// Two modes:
// - Direct (default): fetch https://api.meta.ai/v1 with META_API_KEY.
// - CLI dev mode: set META_CLI to the meta.py helper path. The server then
//   shells out to it, which is how local development runs without ever
//   putting a key in an env file.
//
// Models, all verified against the live API during the hackathon:
// - sam-3.1 via POST /v1/responses (the id "sam-3-1" 404s, use "sam-3.1")
// - muse-image-1.0 via POST /v1/images/generations
// - muse-spark-1.3 via POST /v1/chat/completions (reasoning eats tokens,
//   so vision calls budget 4096 max_tokens)

import { unlink } from "node:fs/promises";

const BASE = "https://api.meta.ai/v1";
// Flat on purpose: the worker draws the only shadow. Asking the backdrop
// for its own shadow area produced two unaligned shadow sources.
const STUDIO_PROMPT =
  "Clean bright professional food photography studio backdrop, seamless flat light gray background, even lighting, no shadows, empty, minimalist, high-end catalog style, no food, no objects, no text";
// The estimate covers ONLY what is visible in the cutout, food and drink
// separated. The input is the worker final (cutout on a plain studio
// backdrop), never the original photo: items dropped from the mask must
// never reappear in the text or price (the Garang Asem regression: rice
// dropped from the image was still promised by the caption and price
// when Spark saw the original). Guessing an unseen drink from an opaque
// glass is forbidden for the same reason.
const ESTIMATE_PROMPT = `Lihat gambar potongan ini. Gambar ini adalah hasil potongan satu set sajian di atas backdrop studio polos. Hanya objek yang lolos potongan yang terlihat di sini, latar asli sudah dibuang. Nilai HANYA yang benar-benar terlihat di gambar potongan ini, jangan tambahkan item dari konteks, latar, atau foto asli; jangan menebak minuman dari gelas buram bila isinya tidak terlihat; jangan menebak item yang tidak terlihat. Bila gambar ini BUKAN sajian makanan atau minuman, jawab dalam JSON saja, tanpa teks lain: {"not_food": true}. Bila gambar ini mengandung konten seksual eksplisit atau ketelanjangan, jawab dalam JSON saja, tanpa teks lain: {"unsafe": true}. Bila ini sajian makanan atau minuman, jawab dalam JSON saja, tanpa teks lain: {"dish": "nama hidangan utama", "items": [{"name": "nama item sajian", "ingredients": [{"name": "...", "amount": "..."}]}], "cost_range_idr": {"min": ..., "max": ...}, "caption_id": "..."}. Aturan: items hanya item yang terlihat di gambar potongan ini, makanan dan minuman dipisah per item; ingredients adalah bahan utama per item dengan takaran perkiraan; cost_range_idr adalah rentang estimasi biaya bahan HANYA untuk item yang terlihat di potongan ini dalam Rupiah di harga pasar Indonesia (bukan harga jual, bukan angka pasti); caption_id adalah caption jualan Bahasa Indonesia yang santai dan menggugah selera, 2-3 kalimat, dan hanya menyebut item yang terlihat di gambar potongan ini.`;

function cli(): string | null {
  return Bun.env.META_CLI || null;
}

function key(): string {
  const value = Bun.env.META_API_KEY;
  if (!value) throw new Error("META_API_KEY belum diisi (lihat .env.example)");
  return value;
}

async function runCli(args: string[]): Promise<any> {
  const proc = Bun.spawn(["python3", cli()!, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) throw new Error(`meta.py gagal: ${err.slice(0, 300)}`);
  return JSON.parse(out);
}

async function post(path: string, payload: unknown): Promise<any> {
  // Timeout di bawah batas 100 detik Cloudflare: kalau Meta menggantung,
  // server mengembalikan JSON error yang bersih, bukan koneksi yang diputus
  // di tengah jalan lalu berubah jadi halaman HTML di depan.
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new Error(`Meta API ${path} -> HTTP ${res.status}`);
  return res.json();
}

// SAM segmentation. Returns the raw output text holding box + mask records.
export async function samSegment(
  imagePath: string,
  prompt: string,
): Promise<string> {
  if (cli()) {
    const data = await runCli([
      "sam",
      "--model",
      "sam-3.1",
      "--image",
      imagePath,
      "--prompt",
      prompt,
    ]);
    return data.response.output[0].content[0].text;
  }
  const bytes = await Bun.file(imagePath).arrayBuffer();
  const mime = imagePath.toLowerCase().endsWith(".png")
    ? "image/png"
    : "image/jpeg";
  const data = await post("/responses", {
    model: "sam-3.1",
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_image",
            image_url: `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`,
          },
          { type: "input_text", text: prompt },
        ],
      },
    ],
    max_output_tokens: 8192,
  });
  return data.output[0].content[0].text;
}

// Studio backdrop. Returns raw PNG bytes.
export async function generateBackdrop(): Promise<Buffer> {
  if (cli()) {
    const tmp = `/tmp/dapurstudio-backdrop-${Date.now()}.png`;
    await runCli(["image", "--prompt", STUDIO_PROMPT, "--out", tmp]);
    const bytes = await Bun.file(tmp).arrayBuffer();
    await unlink(tmp).catch(() => {});
    return Buffer.from(bytes);
  }
  const data = await post("/images/generations", {
    model: "muse-image-1.0",
    prompt: STUDIO_PROMPT,
    n: 1,
    size: "1024x1024",
    response_format: "b64_json",
    output_format: "png",
  });
  return Buffer.from(data.data[0].b64_json, "base64");
}

export interface Estimate {
  dish: string;
  items: { name: string; ingredients: { name: string; amount: string }[] }[];
  cost_range_idr: { min: number; max: number };
  caption_id: string;
  // Content-gate flags, returned INSTEAD of the dish shape above.
  // The server checks these before any dish/items are used.
  not_food?: boolean;
  unsafe?: boolean;
}

// Dish name ONLY, from the ORIGINAL photo. Evidence (exp-b, Garang Asem):
// the dish name from the cutout alone was fish in 3 of 4 runs
// (Pindang 2x, Asem-Asem Ikan 1x, Garang Asem 1x), while the name from the
// original photo was Garang Asem Ayam in 4 of 4 runs (full estimate 2x,
// dish-only 2x). The original carries context the cutout loses, but it
// must NEVER be used for items/price/caption — those stay cutout-only,
// otherwise dropped items (rice, tea) reappear in the text. This call is
// best-effort: on any failure the caller falls back to the cutout dish.
const DISH_PROMPT = `Lihat foto ini. Jawab dalam JSON saja, tanpa teks lain: {"dish": "nama hidangan utama yang terlihat di foto"}. Jangan tambah item, harga, atau caption.`;

export async function dishName(imagePath: string): Promise<string | null> {
  try {
    let content: string;
    if (cli()) {
      const data = await runCli([
        "chat",
        "--image",
        imagePath,
        "--max-tokens",
        "512",
        "--message",
        DISH_PROMPT,
      ]);
      content = data.response.choices[0].message.content;
    } else {
      const bytes = await Bun.file(imagePath).arrayBuffer();
      const mime = imagePath.toLowerCase().endsWith(".png")
        ? "image/png"
        : "image/jpeg";
      const data = await post("/chat/completions", {
        model: "muse-spark-1.3",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: DISH_PROMPT },
              {
                type: "image_url",
                image_url: {
                  url: `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`,
                },
              },
            ],
          },
        ],
        max_tokens: 512,
      });
      content = data.choices[0].message.content;
    }
    const parsed = JSON.parse(content);
    if (typeof parsed.dish === "string" && parsed.dish.trim()) {
      return parsed.dish.trim();
    }
    return null;
  } catch {
    return null;
  }
}

// Dish identification + ingredient cost range + sales caption, as JSON.
export async function estimate(imagePath: string): Promise<Estimate> {
  let content: string;
  if (cli()) {
    const data = await runCli([
      "chat",
      "--image",
      imagePath,
      "--max-tokens",
      "4096",
      "--message",
      ESTIMATE_PROMPT,
    ]);
    content = data.response.choices[0].message.content;
  } else {
    const bytes = await Bun.file(imagePath).arrayBuffer();
    const mime = imagePath.toLowerCase().endsWith(".png")
      ? "image/png"
      : "image/jpeg";
    const data = await post("/chat/completions", {
      model: "muse-spark-1.3",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: ESTIMATE_PROMPT },
            {
              type: "image_url",
              image_url: {
                url: `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`,
              },
            },
          ],
        },
      ],
      max_tokens: 4096,
    });
    content = data.choices[0].message.content;
  }
  const parsed = JSON.parse(content);
  // Gate flags short-circuit the dish validation: a rejected image has
  // no dish/items by design, and the server turns it into one generic
  // rejection message (it never leaks which flag fired).
  if (parsed.not_food === true || parsed.unsafe === true) {
    return parsed as Estimate;
  }
  if (
    !parsed.dish ||
    !Array.isArray(parsed.items) ||
    parsed.items.length === 0 ||
    !parsed.cost_range_idr ||
    !parsed.caption_id
  ) {
    throw new Error("Spark mengembalikan JSON tak lengkap");
  }
  return parsed as Estimate;
}
