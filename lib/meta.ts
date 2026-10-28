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
// The estimate covers the WHOLE serving set, food and drink separated.
// An earlier version assumed one plate and silently dropped the drink.
const ESTIMATE_PROMPT = `Lihat foto ini. Ini satu set sajian: makanan dan minuman pendampingnya. Jawab dalam JSON saja, tanpa teks lain: {"dish": "nama hidangan utama", "items": [{"name": "nama item sajian", "ingredients": [{"name": "...", "amount": "..."}]}], "cost_range_idr": {"min": ..., "max": ...}, "caption_id": "..."}. Aturan: items mencakup SEMUA item sajian di foto, makanan dan minuman dipisah per item; ingredients adalah bahan utama per item dengan takaran perkiraan; cost_range_idr adalah rentang estimasi biaya bahan SELURUH set dalam Rupiah di harga pasar Indonesia (bukan harga jual, bukan angka pasti); caption_id adalah caption jualan Bahasa Indonesia yang santai dan menggugah selera, 2-3 kalimat, sebut hidangan dan minumannya.`;

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
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
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
