// DapurStudio server: one Bun process serving the frontend, the Meta AI
// pipeline, and a JSON-file catalog. No database, no build step.
//
// Pipeline for POST /api/process (the "one set" rule: everything the seller
// photographed as one serving stays in the result):
//   1. SAM 3.1 segments each serving prompt; masks are unioned.
//   2. Muse Image backdrop template (generated once, reviewed, reused).
//   3. scripts/image_worker.py composites the set onto the backdrop.
//   4. Muse Spark identifies the dish, estimates an ingredient cost range,
//      and writes an Indonesian sales caption — from the CUTOUT (final),
//      never from the original photo, so items dropped from the mask can
//      never reappear in the text or price. Spark also returns the
//      content gate (not_food / unsafe); a flagged image is rejected
//      with one generic message and its whole process directory is
//      deleted, so the original photo does not linger on the server.
// The seller then corrects the estimate/caption before saving to /api/catalog.
//
// Langkah 2 (adjust): every process gets its own directory under
// data/processes/<id>/ holding the source photo, the SAM texts, the worker
// mask, the final image, and the metrics. POST /api/adjust re-runs the SAME
// worker CLI on the STORED texts with new parameters and writes a preview
// file; it never overwrites the final. POST /api/adjust/save promotes the
// preview to the final. The client NEVER supplies a file path: every path
// is built server-side from a validated process id, so one process can
// never read or write another process's files.
//
// Status ganda: pipeline status (technical ok/fail) is separate from the
// visual review status. Review reasons are WARNINGS derived from raw worker
// metrics, never a failure: a process can succeed technically while still
// needing a human look. Thresholds are heuristics, documented in
// STEP2_3_NOTES.md, not quality scores.
//
// Env: PORT (default 3000), META_API_KEY (direct mode) or META_CLI
// (dev mode, path to the meta.py helper), META_PYLIBS (optional path
// holding meta-sam-parser for the worker).

import { join, resolve, sep } from "node:path";
import { rename, rm, unlink } from "node:fs/promises";
import { dishName, estimate, generateBackdrop, samSegment } from "./lib/meta";

const PORT = Number(Bun.env.PORT || 3000);
const UPLOADS = "uploads";
const CATALOG = "data/catalog.json";
const PROCESSES = "data/processes";

// Pipeline progress for the UI stepper (GET /api/progress): how many of the
// five pipeline steps have finished for the latest process request. One
// process, one value: fine for a single-seller test deploy, not per-user.
let progressDone = 0;

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

// Worker parameter defaults and clamps. Snap is deliberately NOT exposed:
// it roughened mask edges on every real test photo (langkah 1 evaluation).
const DEFAULT_PARAMS = { expand_px: 0, shadow_strength: 140, shadow_blur: 30 };
const CLAMPS = {
  expand_px: [-20, 20],
  shadow_strength: [0, 255],
  shadow_blur: [0, 100],
} as const;

// Review-warning thresholds (heuristics, not scores, not blocks):
// area below 5% or above 90% of the frame, any dropped SAM detection, or
// the set touching any frame edge. A preview mask growing more than 2% of
// the frame over the current final is also warned: that is the expand
// background-leak signature (measured: untir +20 grew 0.058, seblak +20
// grew 0.040, while a safe +2 grew only 0.008).
const AREA_MIN = 0.05;
const AREA_MAX = 0.9;
const AREA_GROWTH_WARN = 0.02;

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
  const jobPath = `/tmp/dapurstudio-job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
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
  // The frozen worker reports "no mask found" as exit 1 with a JSON
  // {ok: false} body. That is a clean rejection, not a crash: return it
  // so the caller can answer 422 and delete the process. A real crash
  // (no parseable ok:false body) still throws and is cleaned up by the
  // caller's catch.
  if (code !== 0) {
    try {
      const parsed = JSON.parse(out);
      if (parsed && parsed.ok === false) return parsed;
    } catch {
      // Fall through to the throw below.
    }
    throw new Error(`image_worker gagal: ${err.slice(0, 300)}`);
  }
  return JSON.parse(out);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

// --- Process storage: id-validated, confined paths. -----------------------
// A process id is created by the server only, and must match this pattern.
// Anything else (including "../", "%2e%2e", absolute paths) is rejected
// before any path is built, so no client input ever becomes a path.
const ID_PATTERN = /^[A-Za-z0-9_-]+$/;

function newProcessId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// Resolve a file inside a process directory. Throws on an invalid id or on
// any resolved path escaping the processes base (defense in depth: the id
// pattern already excludes separators, the prefix check catches the rest).
function processFile(id: string, name: string): string {
  if (!ID_PATTERN.test(id)) throw new Error("id proses tidak valid");
  const base = resolve(PROCESSES);
  const resolved = resolve(base, id, name);
  if (resolved !== base && !resolved.startsWith(base + sep)) {
    throw new Error("path di luar direktori proses");
  }
  return resolved;
}

// Delete a whole process directory (original, SAM texts, mask, final,
// params, metrics, meta). Used ONLY for rejected/failed processes, so a
// photo that is not processed never lingers on the server. The dir comes
// from processFile(), so it is always confined under data/processes.
async function deleteProcessDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}

async function loadProcess(id: string): Promise<{
  dir: string;
  samTexts: string[];
  meta: any;
  params: any;
  metrics: any;
} | null> {
  let dir: string;
  try {
    dir = processFile(id, "");
  } catch {
    return null;
  }
  try {
    const samTexts = JSON.parse(
      await Bun.file(join(dir, "sam_texts.json")).text(),
    );
    const meta = JSON.parse(await Bun.file(join(dir, "meta.json")).text());
    const params = JSON.parse(
      await Bun.file(join(dir, "params.json")).text(),
    );
    const metrics = JSON.parse(
      await Bun.file(join(dir, "metrics.json")).text(),
    );
    if (!Array.isArray(samTexts) || samTexts.length === 0) return null;
    return { dir, samTexts, meta, params, metrics };
  } catch {
    return null;
  }
}

// --- Review status: warnings from raw metrics, never a pipeline failure. --
function reviewFromMetrics(metrics: any): { needed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const touch = metrics?.border_touch || {};
  const sides = ["left", "right", "top", "bottom"].filter((s) => touch[s]);
  if (sides.length > 0) {
    reasons.push(
      `Sajian menyentuh tepi foto (sisi: ${sides.join(", ")}), periksa apakah ada yang terpotong`,
    );
  }
  if (typeof metrics?.masks_dropped === "number" && metrics.masks_dropped > 0) {
    reasons.push(
      `Sebagian deteksi SAM terbuang (${metrics.masks_dropped}), periksa apakah ada sajian yang hilang`,
    );
  }
  if (typeof metrics?.mask_area_fraction === "number") {
    if (metrics.mask_area_fraction < AREA_MIN) {
      reasons.push(
        "Area sajian sangat kecil dibanding foto (di bawah 5%), periksa apakah potongan terlalu sempit",
      );
    } else if (metrics.mask_area_fraction > AREA_MAX) {
      reasons.push(
        "Area sajian hampir memenuhi foto (di atas 90%), periksa apakah background ikut terpotong",
      );
    }
  }
  return { needed: reasons.length > 0, reasons };
}

// Sides where the preview mask newly touches the frame compared with the
// current final. Used for the expand warning: expand pushing the mask to
// a new edge is exactly the background-leak risk the slider carries.
function borderChangedSides(oldMetrics: any, newMetrics: any): string[] {
  const oldTouch = oldMetrics?.border_touch || {};
  const newTouch = newMetrics?.border_touch || {};
  return ["left", "right", "top", "bottom"].filter(
    (s) => !oldTouch[s] && newTouch[s],
  );
}

// Deterministic caption guard (split hard guard): Spark still invents
// side-item pairings in captions even when items are clean — observed in
// exp-b split_cut_2, where items were Garang Asem only but the caption
// ended with "bareng nasi putih hangat!". Drop any sentence that mentions
// a side item (rice, tea, coffee, plain water) not present in the item
// list. If every sentence is dropped, fall back to a plain dish + items
// line so the caption is never empty and never promises an absent item.
// The seller can still edit the caption in the UI afterwards.
function filterCaption(
  caption: string,
  items: { name: string }[],
  dish: string,
): string {
  const itemText = items.map((i) => i.name.toLowerCase()).join(" ");
  const sideWords: [RegExp, string][] = [
    [/\bnasi\b/i, "nasi"],
    [/\bteh\b/i, "teh"],
    [/\bkopi\b/i, "kopi"],
    [/air putih/i, "air putih"],
    [/es teh/i, "teh"],
  ];
  const sentences = caption.match(/[^.!?]+[.!?]+/g) || [caption];
  const kept = sentences.filter((s) => {
    for (const [re, word] of sideWords) {
      if (re.test(s) && !itemText.includes(word)) return false;
    }
    return true;
  });
  const out = kept.join(" ").trim();
  if (out) return out;
  return `${dish} — ${items.map((i) => i.name).join(", ")}.`;
}

// Clamp one worker parameter. Returns null when the value is present but
// not a finite number (caller turns that into a 400).
function clampParam(
  name: keyof typeof CLAMPS,
  value: unknown,
): number | null {
  if (value === undefined || value === null) return DEFAULT_PARAMS[name];
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  const [lo, hi] = CLAMPS[name];
  return Math.max(lo, Math.min(hi, Math.round(num)));
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/api/health") {
      return json({ ok: true, service: "dapurstudio" });
    }

    if (path === "/api/progress") {
      return json({ done: progressDone });
    }

    if (path === "/api/catalog" && req.method === "GET") {
      return json(await readCatalog());
    }

    if (path === "/api/catalog" && req.method === "POST") {
      const item = await req.json();
      // Catalog gate (langkah A): an entry must be linked to a real,
      // completed process directory. Without this, the API alone could
      // invent catalog entries with no photo and no content gate. The
      // seller may still freely edit dish/items/caption/price for a
      // valid process — that is the normal UI flow (app.js only sends
      // processId from a successful process), it is not blocked here.
      if (typeof item.processId !== "string" || !(await loadProcess(item.processId))) {
        return json({ error: "entri katalog harus berasal dari proses foto yang valid" }, 400);
      }
      const catalog = await readCatalog();
      const saved: any = {
        id: `${Date.now()}`,
        createdAt: new Date().toISOString(),
        ...item,
        processId: item.processId,
      };
      catalog.unshift(saved);
      await Bun.write(CATALOG, JSON.stringify(catalog, null, 2));
      return json(saved, 201);
    }

    if (path === "/api/process" && req.method === "POST") {
      // Declared outside try so the catch can clean up a half-finished
      // process (original already written, SAM/worker/estimate failed).
      let processDir: string | null = null;
      try {
        progressDone = 0;
        const form = await req.formData();
        const photo = form.get("photo");
        if (!(photo instanceof File)) {
          return json({ error: "field photo wajib diisi" }, 400);
        }
        const id = newProcessId();
        const dir = processFile(id, "");
        processDir = dir;
        const ext = photo.type === "image/png" ? "png" : "jpg";
        const originalPath = join(dir, `original.${ext}`);
        await Bun.write(originalPath, photo);
        progressDone = 1;

        const texts = await Promise.all(
          SERVING_PROMPTS.map((prompt) =>
            samSegment(originalPath, prompt).catch(() => ""),
          ),
        );
        const samTexts = texts.filter(Boolean);
        progressDone = 2;
        // Validated template first: one flat backdrop, generated once and
        // reviewed, reused for every photo. Generating a fresh backdrop per
        // photo wasted $0.01 and a call, and could come back non-empty.
        const template = "assets/backdrops/studio-light-gray.png";
        const backdropPath = (await Bun.file(template).exists())
          ? template
          : `${UPLOADS}/${id}-backdrop.png`;
        if (backdropPath !== template) {
          await Bun.write(backdropPath, await generateBackdrop());
        }
        progressDone = 3;
        const finalPath = join(dir, "final.png");
        const maskPath = join(dir, "mask.png");
        const worker = await runWorker({
          original: originalPath,
          backdrop: backdropPath,
          sam_texts: samTexts,
          output: finalPath,
          mask_output: maskPath,
        });
        if (!worker.ok) {
          // No serving mask: the photo is not processed, so do not keep
          // the original (or any partial file) on the server.
          await deleteProcessDir(dir);
          return json(
            { error: "tidak ada sajian terdeteksi di foto ini" },
            422,
          );
        }
        progressDone = 4;
        // Gate input is the CUTOUT, never the original: only objects that
        // survived the mask are visible to Spark, so dropped items can
        // never reappear in the dish, items, price, or caption.
        const result = await estimate(finalPath);
        if (result.not_food === true || result.unsafe === true) {
          // One generic message for both flags: the client never learns
          // which flag fired, and the whole process is deleted.
          await deleteProcessDir(dir);
          return json(
            {
              error:
                "Foto ini tidak terlihat seperti sajian makanan atau minuman, jadi tidak bisa diproses",
            },
            422,
          );
        }
        // Split (exp-b evidence): dish name from the ORIGINAL photo
        // (Garang Asem 4/4), items/price/caption strictly from the CUTOUT
        // (no rice/tea in items). The dish call is best-effort: on
        // failure the cutout dish is kept, the process never fails for
        // this. The caption then passes the deterministic filter above,
        // so a hallucinated side-item sentence can never reach the
        // catalog even if Spark writes one.
        const originalDish = await dishName(originalPath);
        if (originalDish) result.dish = originalDish;
        result.caption_id = filterCaption(result.caption_id, result.items, result.dish);
        progressDone = 5;
        // Persist the whole process: source, SAM texts, mask, final, params,
        // metrics. Adjust later re-runs the worker from these stored texts,
        // never from anything the client sends.
        await Bun.write(join(dir, "sam_texts.json"), JSON.stringify(samTexts));
        await Bun.write(join(dir, "params.json"), JSON.stringify(DEFAULT_PARAMS));
        await Bun.write(
          join(dir, "metrics.json"),
          JSON.stringify({
            masks_kept: worker.masks_kept,
            masks_dropped: worker.masks_dropped,
            mask_area_fraction: worker.mask_area_fraction,
            border_touch: worker.border_touch,
            edge_roughness: worker.edge_roughness,
          }),
        );
        await Bun.write(
          join(dir, "meta.json"),
          JSON.stringify({
            backdrop: backdropPath,
            dish: result.dish,
            items: result.items,
            costRangeIdr: result.cost_range_idr,
            caption: result.caption_id,
          }),
        );
        const metrics = JSON.parse(
          await Bun.file(join(dir, "metrics.json")).text(),
        );
        return json({
          id,
          pipeline: { ok: true },
          review: reviewFromMetrics(metrics),
          imageUrl: `/api/processes/${id}/final`,
          dish: result.dish,
          items: result.items,
          costRangeIdr: result.cost_range_idr,
          caption: result.caption_id,
        });
      } catch (error) {
        // Any failure after the original was written (SAM, backdrop,
        // worker, estimate, or estimate parsing) must not leave the
        // photo behind either. A process that was never persisted
        // (no sam_texts.json/meta.json yet) is safe to delete wholesale.
        if (processDir) await deleteProcessDir(processDir);
        console.error(error);
        return json({ error: "proses gagal, coba lagi" }, 500);
      }
    }

    // --- Adjust: preview only, never touches the final. -------------------
    if (path === "/api/adjust" && req.method === "POST") {
      try {
        const body = await req.json();
        // ONLY these fields are read. Any client-supplied path (mask path,
        // original path, output path, or anything else) is ignored outright,
        // never resolved, never opened.
        const id = typeof body.id === "string" ? body.id : "";
        const proc = await loadProcess(id);
        if (!proc) {
          // Unknown id and malformed id share one generic 404: no oracle
          // for which process ids exist.
          return json({ error: "proses tidak ditemukan" }, 404);
        }
        let params: any;
        if (body.reset === true) {
          params = { ...DEFAULT_PARAMS };
        } else {
          const expand = clampParam("expand_px", body.expand_px);
          const strength = clampParam("shadow_strength", body.shadow_strength);
          const blur = clampParam("shadow_blur", body.shadow_blur);
          if (expand === null || strength === null || blur === null) {
            return json({ error: "parameter penyesuaian tidak valid" }, 400);
          }
          params = {
            expand_px: expand,
            shadow_strength: strength,
            shadow_blur: blur,
          };
        }
        const originalFile = (await Bun.file(join(proc.dir, "original.jpg")).exists())
          ? join(proc.dir, "original.jpg")
          : join(proc.dir, "original.png");
        const previewPath = join(proc.dir, "preview.png");
        const previewMaskPath = join(proc.dir, "preview-mask.png");
        const worker = await runWorker({
          original: originalFile,
          backdrop: proc.meta.backdrop,
          sam_texts: proc.samTexts,
          output: previewPath,
          mask_output: previewMaskPath,
          expand_px: params.expand_px,
          shadow_strength: params.shadow_strength,
          shadow_blur: params.shadow_blur,
        });
        if (!worker.ok) {
          return json(
            { error: "penyesuaian tidak menghasilkan potongan (mask kosong)" },
            422,
          );
        }
        const newMetrics = {
          masks_kept: worker.masks_kept,
          masks_dropped: worker.masks_dropped,
          mask_area_fraction: worker.mask_area_fraction,
          border_touch: worker.border_touch,
          edge_roughness: worker.edge_roughness,
        };
        await Bun.write(
          join(proc.dir, "preview-params.json"),
          JSON.stringify(params),
        );
        await Bun.write(
          join(proc.dir, "preview-metrics.json"),
          JSON.stringify(newMetrics),
        );
        const changed = borderChangedSides(proc.metrics, newMetrics);
        const review = reviewFromMetrics(newMetrics);
        if (changed.length > 0) {
          review.reasons.push(
            `Expand mendorong mask ke tepi frame (sisi: ${changed.join(", ")}), periksa pratinjau apakah background ikut masuk`,
          );
          review.needed = true;
        }
        // Expand leak signature: the preview mask grew far beyond the
        // current final. Border-change alone misses this when the mask
        // already touched an edge before expanding (untir, seblak).
        const areaGrowth =
          typeof newMetrics.mask_area_fraction === "number" &&
          typeof proc.metrics.mask_area_fraction === "number"
            ? newMetrics.mask_area_fraction - proc.metrics.mask_area_fraction
            : 0;
        if (areaGrowth > AREA_GROWTH_WARN) {
          review.reasons.push(
            `Mask membesar ${(areaGrowth * 100).toFixed(1)}% dibanding hasil saat ini, periksa pratinjau apakah background ikut masuk`,
          );
          review.needed = true;
        }
        return json({
          pipeline: { ok: true },
          review,
          previewUrl: `/api/processes/${id}/preview`,
          params,
          metrics: newMetrics,
          borderChanged: changed,
          areaGrowth,
        });
      } catch (error) {
        console.error(error);
        return json({ error: "penyesuaian gagal, coba lagi" }, 500);
      }
    }

    // --- Adjust save: promote preview to final, update linked catalog entry.
    if (path === "/api/adjust/save" && req.method === "POST") {
      try {
        const body = await req.json();
        const id = typeof body.id === "string" ? body.id : "";
        const proc = await loadProcess(id);
        if (!proc) {
          return json({ error: "proses tidak ditemukan" }, 404);
        }
        const previewPath = join(proc.dir, "preview.png");
        const previewParamsPath = join(proc.dir, "preview-params.json");
        const previewMetricsPath = join(proc.dir, "preview-metrics.json");
        if (
          !(await Bun.file(previewPath).exists()) ||
          !(await Bun.file(previewParamsPath).exists()) ||
          !(await Bun.file(previewMetricsPath).exists())
        ) {
          return json(
            { error: "belum ada pratinjau, buat pratinjau dulu sebelum simpan" },
            409,
          );
        }
        const finalPath = join(proc.dir, "final.png");
        const tmpPath = join(proc.dir, "final.tmp.png");
        await Bun.write(tmpPath, Bun.file(previewPath));
        await rename(tmpPath, finalPath);
        const params = JSON.parse(await Bun.file(previewParamsPath).text());
        const metrics = JSON.parse(await Bun.file(previewMetricsPath).text());
        await Bun.write(join(proc.dir, "params.json"), JSON.stringify(params));
        await Bun.write(join(proc.dir, "metrics.json"), JSON.stringify(metrics));
        // Preview files are consumed by the promotion: remove them so a
        // second save without a fresh preview fails cleanly (409).
        for (const name of ["preview.png", "preview-mask.png", "preview-params.json", "preview-metrics.json"]) {
          await unlink(join(proc.dir, name)).catch(() => {});
        }
        // A catalog entry linked to this process points at the same final
        // URL, so it shows the new image automatically; refresh its
        // traceability fields only.
        const catalog = await readCatalog();
        let touched = false;
        for (const entry of catalog) {
          if (entry.processId === id) {
            entry.adjustedParams = params;
            entry.updatedAt = new Date().toISOString();
            touched = true;
          }
        }
        if (touched) {
          await Bun.write(CATALOG, JSON.stringify(catalog, null, 2));
        }
        return json({
          ok: true,
          imageUrl: `/api/processes/${id}/final`,
          params,
          review: reviewFromMetrics(metrics),
        });
      } catch (error) {
        console.error(error);
        return json({ error: "simpan penyesuaian gagal, coba lagi" }, 500);
      }
    }

    // --- Process files: id-validated, confined, read-only. -----------------
    if (path.startsWith("/api/processes/")) {
      const segments = path.slice("/api/processes/".length).split("/");
      if (segments.length === 2) {
        const [id, kind] = segments;
        const fileMap: Record<string, string> = {
          final: "final.png",
          preview: "preview.png",
          original: "original.jpg",
        };
        let fileName = fileMap[kind];
        if (kind === "original") {
          // Original may be jpg or png; resolve from disk, still confined.
          try {
            const dir = processFile(id, "");
            fileName = (await Bun.file(join(dir, "original.jpg")).exists())
              ? "original.jpg"
              : "original.png";
          } catch {
            return new Response("tidak ditemukan", { status: 404 });
          }
        }
        if (!fileName) return new Response("tidak ditemukan", { status: 404 });
        let filePath: string;
        try {
          filePath = processFile(id, fileName);
        } catch {
          return new Response("tidak ditemukan", { status: 404 });
        }
        const file = Bun.file(filePath);
        if (!(await file.exists())) {
          return new Response("tidak ditemukan", { status: 404 });
        }
        return new Response(file, {
          headers: { "Content-Type": MIME[".png"] || "image/png" },
        });
      }
      return new Response("tidak ditemukan", { status: 404 });
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
