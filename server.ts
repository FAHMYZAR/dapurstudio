// DapurStudio server: one Bun process serving the frontend, the Meta AI
// pipeline, and a JSON-file catalog. No database, no build step.
//
// Pipeline for POST /api/process (the "one set" rule: everything the seller
// photographed as one serving stays in the result):
//   1. SAM 3.1 segments each serving prompt; masks are unioned.
//   2. Muse Image generates a studio backdrop.
//   3. scripts/image_worker.py composites the set onto the backdrop.
//   4. Muse Spark identifies the dish, estimates an ingredient cost range,
//      and writes an Indonesian sales caption.
// The seller then corrects the estimate/caption before saving to /api/catalog.
//
// Env: PORT (default 3000), META_API_KEY (direct mode) or META_CLI
// (dev mode, path to the meta.py helper), META_PYLIBS (optional path
// holding meta-sam-parser for the worker).

import { estimate, generateBackdrop, samSegment } from "./lib/meta";

const PORT = Number(Bun.env.PORT || 3000);
const UPLOADS = "uploads";
const CATALOG = "data/catalog.json";

// Serving prompts, tried in parallel. A prompt that finds nothing is skipped;
// the union keeps every serving object the photo actually contains.
// Prompt wording matters, measured 27 Okt 2026 against the verified slice
// mask: bare "plate of food" masks only the plate ring (food becomes holes),
// while "plated food" and "plate of fried food" mask the whole dish assembly.
// Unioning them keeps the assembly; the ring-only mask is harmless inside it.
const SERVING_PROMPTS = [
  "plated food",
  "plate of fried food",
  "plate of food",
  "coffee mug",
  "glass",
  "cup",
];

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".json": "application/json; charset=utf-8",
};

async function readCatalog(): Promise<any[]> {
  try {
    return JSON.parse(await Bun.file(CATALOG).text());
  } catch {
    return [];
  }
}

async function runWorker(job: Record<string, unknown>): Promise<any> {
  const jobPath = `/tmp/dapurstudio-job-${Date.now()}.json`;
  await Bun.write(jobPath, JSON.stringify(job));
  const env: Record<string, string> = { ...process.env };
  if (Bun.env.META_PYLIBS) {
    env.PYTHONPATH = Bun.env.META_PYLIBS;
  }
  const proc = Bun.spawn(["python3", "scripts/image_worker.py", jobPath], {
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) throw new Error(`image_worker gagal: ${err.slice(0, 300)}`);
  return JSON.parse(out);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/api/health") {
      return json({ ok: true, service: "dapurstudio" });
    }

    if (path === "/api/catalog" && req.method === "GET") {
      return json(await readCatalog());
    }

    if (path === "/api/catalog" && req.method === "POST") {
      const item = await req.json();
      const catalog = await readCatalog();
      const saved = {
        id: `${Date.now()}`,
        createdAt: new Date().toISOString(),
        ...item,
      };
      catalog.unshift(saved);
      await Bun.write(CATALOG, JSON.stringify(catalog, null, 2));
      return json(saved, 201);
    }

    if (path === "/api/process" && req.method === "POST") {
      try {
        const form = await req.formData();
        const photo = form.get("photo");
        if (!(photo instanceof File)) {
          return json({ error: "field photo wajib diisi" }, 400);
        }
        const id = `${Date.now()}`;
        const ext = photo.type === "image/png" ? "png" : "jpg";
        const originalPath = `${UPLOADS}/${id}.${ext}`;
        await Bun.write(originalPath, photo);

        const texts = await Promise.all(
          SERVING_PROMPTS.map((prompt) =>
            samSegment(originalPath, prompt).catch(() => ""),
          ),
        );
        const samTexts = texts.filter(Boolean);
        const backdropPath = `${UPLOADS}/${id}-backdrop.png`;
        await Bun.write(backdropPath, await generateBackdrop());
        const catalogPath = `${UPLOADS}/${id}-catalog.png`;
        const worker = await runWorker({
          original: originalPath,
          backdrop: backdropPath,
          sam_texts: samTexts,
          output: catalogPath,
        });
        if (!worker.ok) {
          return json(
            { error: "tidak ada sajian terdeteksi di foto ini" },
            422,
          );
        }
        const result = await estimate(originalPath);
        return json({
          imageUrl: `/${catalogPath}`,
          dish: result.dish,
          ingredients: result.ingredients,
          costRangeIdr: result.cost_range_idr,
          caption: result.caption_id,
        });
      } catch (error) {
        console.error(error);
        return json({ error: "proses gagal, coba lagi" }, 500);
      }
    }

    if (path.startsWith("/uploads/")) {
      const name = path.slice("/uploads/".length).replace(/[^A-Za-z0-9._-]/g, "");
      const file = Bun.file(`${UPLOADS}/${name}`);
      if (!(await file.exists())) return new Response("tidak ditemukan", { status: 404 });
      return new Response(file);
    }

    const filePath =
      path === "/" ? "public/index.html" : `public${path}`;
    const file = Bun.file(filePath);
    if (await file.exists()) {
      const ext = filePath.slice(filePath.lastIndexOf("."));
      return new Response(file, {
        headers: { "Content-Type": MIME[ext] || "application/octet-stream" },
      });
    }
    return new Response("tidak ditemukan", { status: 404 });
  },
});

console.log(`DapurStudio jalan di http://localhost:${server.port}`);
