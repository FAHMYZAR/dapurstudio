const $ = (id) => document.getElementById(id);
let current = null;
let uploadFile = null;

// --- Crop editor state (langkah 3: crop SEBELUM proses, di sisi client). ---
// crop is fractions of the original photo (x, y, w, h). The crop box the user
// drags sits over the displayed photo; fractions map linearly to natural
// pixels because the displayed image keeps its aspect ratio.
// processedCrop is the crop snapshot the current process was built from.
// If the crop changes afterwards, adjust is disabled and the UI forces a
// re-process (new process id, new SAM call). The server enforces the same
// rule structurally: adjust always uses the stored source of its own id.
let cropImg = null;
let cropFile = null;
let crop = { x: 0, y: 0, w: 1, h: 1 };
let processedCrop = null;
let cropObjectUrl = null;
let previewObjectUrl = null;
let finalVersion = 0;

// Respons yang bukan JSON (misalnya halaman error HTML dari Cloudflare atau
// tunnel saat koneksi diputus) harus jadi pesan manusiawi, bukan pesan mentah
// mesin JS tentang token "<".
async function readJson(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      "Server mengembalikan respons yang tidak dikenali (kemungkinan koneksi diputus di tengah jalan). Coba lagi, kalau perlu dengan foto yang lebih kecil.",
    );
  }
}

const esc = (text) =>
  String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

// Stepper: step i (1-based) is done when i <= done, active while processing
// when i === done + 1, waiting otherwise. Numbers come back for waiting steps.
function setProgress(done, processing) {
  for (let i = 1; i <= 5; i++) {
    const li = $("step-" + i);
    if (!li) continue;
    const num = li.querySelector(".step-num");
    li.classList.remove("done", "active");
    if (i <= done) {
      li.classList.add("done");
      num.textContent = "✓";
    } else {
      num.textContent = String(i);
      if (processing && i === done + 1) li.classList.add("active");
    }
  }
}

function updateCostHero() {
  const min = Number($("cost-min").value);
  const max = Number($("cost-max").value);
  $("cost-hero").textContent =
    min && max
      ? `Rp ${min.toLocaleString("id-ID")} - Rp ${max.toLocaleString("id-ID")}`
      : "";
}

$("cost-min").addEventListener("input", updateCostHero);
$("cost-max").addEventListener("input", updateCostHero);

// --- Crop editor ------------------------------------------------------------
// Position the box from fractions. The stage is exactly the image box, so
// percentages line up with the photo on any screen size.
function renderCropBox() {
  const box = $("crop-box");
  box.style.left = `${crop.x * 100}%`;
  box.style.top = `${crop.y * 100}%`;
  box.style.width = `${crop.w * 100}%`;
  box.style.height = `${crop.h * 100}%`;
}

function cropSnapshot() {
  return JSON.stringify(crop);
}

// Crop changed after a process: adjust no longer applies to this crop, so
// disable it and force a re-process. Server-side the same rule holds: an
// adjust call always uses its own id's stored source, never a new crop.
function checkCropStale() {
  const stale = processedCrop !== null && cropSnapshot() !== processedCrop;
  $("crop-note").hidden = !stale;
  $("crop-note").textContent = stale
    ? "Crop berubah. Proses ulang untuk hasil baru (ID proses baru, panggilan SAM baru). Penyesuaian proses lama dinonaktifkan."
    : "";
  refreshAdjustEnabled();
}

function refreshAdjustEnabled() {
  const stale = processedCrop !== null && cropSnapshot() !== processedCrop;
  const enabled = current !== null && current.id && !stale;
  ["adj-preview", "adj-reset", "adj-save"].forEach((id) => {
    $(id).disabled = !enabled;
  });
}

// Build the upload file: crop from the ORIGINAL photo first, then downscale
// to at most 1600px and encode JPEG 0.85 (the existing production behavior).
// Foto HP bisa 7 MB lebih: enam panggilan SAM yang masing-masing mengunggah
// foto itu sebagai base64 jadi puluhan MB dan prosesnya menggantung sampai
// koneksi depan diputus. Yang diproses sama dengan yang tampil di pratinjau.
// On any failure, fall back to the full original file (spec fallback).
function rebuildUpload() {
  if (!cropImg || !cropFile) return;
  $("process").disabled = true;
  try {
    const sx = Math.round(crop.x * cropImg.naturalWidth);
    const sy = Math.round(crop.y * cropImg.naturalHeight);
    const sw = Math.max(1, Math.round(crop.w * cropImg.naturalWidth));
    const sh = Math.max(1, Math.round(crop.h * cropImg.naturalHeight));
    const scale = Math.min(1, 1600 / Math.max(sw, sh));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(sw * scale));
    canvas.height = Math.max(1, Math.round(sh * scale));
    canvas.getContext("2d").drawImage(cropImg, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(
      (blob) => {
        uploadFile = blob
          ? new File([blob], cropFile.name, { type: "image/jpeg" })
          : cropFile;
        if (previewObjectUrl) URL.revokeObjectURL(previewObjectUrl);
        previewObjectUrl = URL.createObjectURL(uploadFile);
        $("preview").src = previewObjectUrl;
        $("preview").hidden = false;
        $("original-image").src = previewObjectUrl;
        $("process").disabled = false;
      },
      "image/jpeg",
      0.85,
    );
  } catch {
    uploadFile = cropFile;
    if (previewObjectUrl) URL.revokeObjectURL(previewObjectUrl);
    previewObjectUrl = URL.createObjectURL(cropFile);
    $("preview").src = previewObjectUrl;
    $("preview").hidden = false;
    $("original-image").src = previewObjectUrl;
    $("process").disabled = false;
  }
}

$("photo").addEventListener("change", () => {
  const file = $("photo").files[0];
  if (!file) return;
  $("upload-label").textContent = file.name;
  $("process").disabled = true;
  // A new photo retires the previous process's adjust panel: the panel
  // belongs to a process id, and a new photo means a new process.
  $("adjust").hidden = true;
  processedCrop = null;
  crop = { x: 0, y: 0, w: 1, h: 1 };
  cropFile = file;
  const img = new Image();
  if (cropObjectUrl) URL.revokeObjectURL(cropObjectUrl);
  cropObjectUrl = URL.createObjectURL(file);
  img.onload = () => {
    cropImg = img;
    $("crop-img").src = cropObjectUrl;
    $("crop-wrap").hidden = false;
    renderCropBox();
    rebuildUpload();
  };
  img.onerror = () => {
    cropImg = null;
    uploadFile = file;
    if (previewObjectUrl) URL.revokeObjectURL(previewObjectUrl);
    previewObjectUrl = URL.createObjectURL(file);
    $("preview").src = previewObjectUrl;
    $("preview").hidden = false;
    $("original-image").src = previewObjectUrl;
    $("process").disabled = false;
  };
  img.src = cropObjectUrl;
});

// Crop dragging: pointer events with capture, so touch on phones works.
// A drag on the box moves it; a drag on a corner handle resizes from the
// opposite corner. touch-action: none (CSS) keeps the page from scrolling
// mid-drag.
(function initCropDrag() {
  const stage = $("crop-stage");
  const box = $("crop-box");
  let mode = null;
  let start = null;

  function fractionsFromEvent(event) {
    const rect = stage.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) / rect.width,
      y: (event.clientY - rect.top) / rect.height,
    };
  }

  box.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    const handle = event.target.closest(".crop-handle");
    const point = fractionsFromEvent(event);
    start = { px: point.x, py: point.y, crop: { ...crop } };
    mode = handle ? `resize-${handle.dataset.handle}` : "move";
    box.setPointerCapture(event.pointerId);
  });

  box.addEventListener("pointermove", (event) => {
    if (!mode || !start) return;
    const point = fractionsFromEvent(event);
    const dx = point.x - start.px;
    const dy = point.y - start.py;
    const min = 0.1;
    const clamp01 = (v) => Math.max(0, Math.min(1, v));
    if (mode === "move") {
      crop.x = clamp01(start.crop.x + dx);
      crop.x = Math.min(crop.x, 1 - crop.w);
      crop.y = clamp01(start.crop.y + dy);
      crop.y = Math.min(crop.y, 1 - crop.h);
    } else {
      const corner = mode.slice("resize-".length);
      const right = start.crop.x + start.crop.w;
      const bottom = start.crop.y + start.crop.h;
      if (corner.includes("e")) {
        crop.w = Math.max(min, Math.min(1 - start.crop.x, start.crop.w + dx));
      }
      if (corner.includes("s")) {
        crop.h = Math.max(min, Math.min(1 - start.crop.y, start.crop.h + dy));
      }
      if (corner.includes("w")) {
        const nx = Math.max(0, Math.min(right - min, start.crop.x + dx));
        crop.w = right - nx;
        crop.x = nx;
      }
      if (corner.includes("n")) {
        const ny = Math.max(0, Math.min(bottom - min, start.crop.y + dy));
        crop.h = bottom - ny;
        crop.y = ny;
      }
    }
    renderCropBox();
  });

  function endDrag(event) {
    if (!mode) return;
    mode = null;
    start = null;
    try {
      box.releasePointerCapture(event.pointerId);
    } catch {}
    rebuildUpload();
    checkCropStale();
  }
  box.addEventListener("pointerup", endDrag);
  box.addEventListener("pointercancel", endDrag);
})();

$("crop-reset").addEventListener("click", () => {
  crop = { x: 0, y: 0, w: 1, h: 1 };
  renderCropBox();
  rebuildUpload();
  checkCropStale();
});

document.querySelectorAll(".tabs button").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tabs button").forEach((other) => {
      other.setAttribute("aria-selected", other === tab ? "true" : "false");
    });
    document.querySelectorAll("[role=tabpanel]").forEach((panel) => {
      panel.hidden = panel.id !== tab.dataset.tab;
    });
  });
});

// --- Review status: pipeline success and visual review are separate. --------
// A warning never turns a successful pipeline into a failure.
function renderReview(review) {
  $("pipeline-status").textContent = "Proses berhasil.";
  const needed = review && review.needed;
  $("review-box").hidden = !needed;
  $("review-ok").hidden = !!needed;
  if (needed) {
    $("review-reasons").innerHTML = (review.reasons || [])
      .map((reason) => `<li>${esc(reason)}</li>`)
      .join("");
  }
}

function resetAdjustSliders() {
  $("adj-expand").value = 0;
  $("adj-expand-val").textContent = "0 px";
  $("adj-strength").value = 140;
  $("adj-strength-val").textContent = "140";
  $("adj-blur").value = 30;
  $("adj-blur-val").textContent = "30";
  $("expand-warning").hidden = true;
  $("expand-warning").textContent = "";
}

$("adj-expand").addEventListener("input", () => {
  $("adj-expand-val").textContent = `${$("adj-expand").value} px`;
});
$("adj-strength").addEventListener("input", () => {
  $("adj-strength-val").textContent = $("adj-strength").value;
});
$("adj-blur").addEventListener("input", () => {
  $("adj-blur-val").textContent = $("adj-blur").value;
});

function adjustParams() {
  return {
    expand_px: Number($("adj-expand").value),
    shadow_strength: Number($("adj-strength").value),
    shadow_blur: Number($("adj-blur").value),
  };
}

async function callAdjust(body) {
  const res = await fetch("/api/adjust", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await readJson(res);
  if (!res.ok) throw new Error(data.error || "penyesuaian gagal");
  return data;
}

function showPreview(data) {
  // The preview never replaces the final until saved: compare shows the
  // current final next to the preview, and the main SESUDAH stays put.
  $("compare-final").src = `${current.imageUrl}?v=${finalVersion}`;
  $("compare-preview").src = `${data.previewUrl}?v=${Date.now()}`;
  $("compare").hidden = false;
  renderReview(data.review);
  const changed = data.borderChanged || [];
  $("expand-warning").hidden = changed.length === 0;
  $("expand-warning").textContent =
    changed.length > 0
      ? `Expand mendorong mask ke tepi frame (sisi: ${changed.join(", ")}). Periksa pratinjau apakah background ikut masuk.`
      : "";
  $("adjust-note").textContent =
    "Ini pratinjau saja, hasil katalog belum berubah. Tekan Simpan penyesuaian untuk memakai hasil ini.";
}

$("adj-preview").addEventListener("click", async () => {
  if (!current || !current.id) return;
  $("adjust-note").textContent = "Membuat pratinjau...";
  try {
    const data = await callAdjust({ id: current.id, ...adjustParams() });
    showPreview(data);
  } catch (error) {
    $("adjust-note").textContent = error.message;
  }
});

$("adj-reset").addEventListener("click", async () => {
  if (!current || !current.id) return;
  resetAdjustSliders();
  $("adjust-note").textContent = "Membuat pratinjau default...";
  try {
    const data = await callAdjust({ id: current.id, reset: true });
    showPreview(data);
  } catch (error) {
    $("adjust-note").textContent = error.message;
  }
});

$("adj-save").addEventListener("click", async () => {
  if (!current || !current.id) return;
  $("adjust-note").textContent = "Menyimpan penyesuaian...";
  try {
    const res = await fetch("/api/adjust/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: current.id }),
    });
    const data = await readJson(res);
    if (!res.ok) throw new Error(data.error || "simpan penyesuaian gagal");
    finalVersion += 1;
    current.imageUrl = data.imageUrl;
    $("result-image").src = `${data.imageUrl}?v=${finalVersion}`;
    $("compare").hidden = true;
    renderReview(data.review);
    $("expand-warning").hidden = true;
    $("adjust-note").textContent =
      "Penyesuaian tersimpan. Gambar SESUDAH sudah diperbarui.";
  } catch (error) {
    $("adjust-note").textContent = error.message;
  }
});

$("process").addEventListener("click", async () => {
  const file = uploadFile || $("photo").files[0];
  if (!file) {
    $("status").textContent = "Pilih foto dulu.";
    return;
  }
  $("status").textContent = "Memproses, tunggu sebentar...";
  $("process").disabled = true;
  $("process").querySelector(".spinner").hidden = false;
  $("pipeline").hidden = false;
  setProgress(0, true);
  const poll = setInterval(async () => {
    try {
      const r = await fetch("/api/progress");
      const p = await r.json();
      setProgress(p.done || 0, true);
    } catch {}
  }, 1500);
  try {
    const form = new FormData();
    form.append("photo", file);
    const res = await fetch("/api/process", { method: "POST", body: form });
    const data = await readJson(res);
    if (!res.ok) throw new Error(data.error || "proses gagal");
    current = data;
    finalVersion = 0;
    // The crop this process was built from: any later crop change retires
    // this process's adjust panel until a re-process happens.
    processedCrop = cropSnapshot();
    $("result-image").src = data.imageUrl;
    $("dish").value = data.dish;
    $("cost-min").value = data.costRangeIdr.min;
    $("cost-max").value = data.costRangeIdr.max;
    updateCostHero();
    $("ingredients").value = data.items
      .flatMap((group) =>
        group.ingredients.map(
          (item) => `${group.name} | ${item.name}: ${item.amount}`,
        ),
      )
      .join("\n");
    $("caption").value = data.caption;
    setProgress(5, false);
    $("result").hidden = false;
    // Adjust panel belongs to this process id from now on.
    $("adjust").hidden = false;
    $("compare").hidden = true;
    $("adjust-note").textContent = "";
    resetAdjustSliders();
    renderReview(data.review);
    refreshAdjustEnabled();
    $("result").scrollIntoView({ behavior: "smooth", block: "start" });
    $("status").textContent = "Jadi. Koreksi dulu kalau perlu, lalu simpan.";
  } catch (error) {
    $("status").textContent = error.message;
  } finally {
    clearInterval(poll);
    $("process").disabled = false;
    $("process").querySelector(".spinner").hidden = true;
  }
});

$("save").addEventListener("click", async () => {
  if (!current) return;
  const groups = new Map();
  for (const line of $("ingredients").value.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [groupName, rest] = trimmed.includes(" | ")
      ? trimmed.split(" | ", 2)
      : ["Lainnya", trimmed];
    const sep = rest.lastIndexOf(": ");
    const name = sep >= 0 ? rest.slice(0, sep) : rest;
    const amount = sep >= 0 ? rest.slice(sep + 2) : "";
    if (!groups.has(groupName)) groups.set(groupName, []);
    groups.get(groupName).push({ name, amount });
  }
  const item = {
    imageUrl: current.imageUrl,
    dish: $("dish").value,
    costRangeIdr: {
      min: Number($("cost-min").value),
      max: Number($("cost-max").value),
    },
    items: [...groups.entries()].map(([name, ingredients]) => ({
      name,
      ingredients,
    })),
    caption: $("caption").value,
  };
  // Link the catalog entry to its process so a later adjust/save can
  // refresh it. The entry's imageUrl points at the process final, which
  // the promotion updates in place.
  if (current.id) item.processId = current.id;
  await fetch("/api/catalog", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(item),
  });
  $("status").textContent = "Tersimpan di katalog.";
  loadCatalog();
});

async function loadCatalog() {
  let items = [];
  try {
    items = await readJson(await fetch("/api/catalog"));
  } catch {
    items = [];
  }
  const renderItems = (item) => {
    if (typeof item.items === "string") return `<p>${esc(item.items)}</p>`;
    if (!Array.isArray(item.items)) return "";
    return item.items
      .map(
        (group) =>
          `<p><strong>${esc(group.name)}</strong><br>${group.ingredients
            .map((entry) => `${esc(entry.name)}: ${esc(entry.amount)}`)
            .join("<br>")}</p>`,
      )
      .join("");
  };
  $("catalog").innerHTML = items.length
    ? items
        .map(
          (item) => `
      <article class="item">
        <img src="${esc(item.imageUrl)}" alt="">
        <div>
          <strong>${esc(item.dish)}</strong>
          <p class="price">Rp ${item.costRangeIdr.min.toLocaleString("id-ID")} - Rp ${item.costRangeIdr.max.toLocaleString("id-ID")}</p>
          <p class="pill">Siap katalog</p>
          ${item.createdAt ? `<p class="saved">${new Date(item.createdAt).toLocaleDateString("id-ID", { day: "numeric", month: "short", year: "numeric" })}</p>` : ""}
          ${renderItems(item)}
          <p>${esc(item.caption)}</p>
        </div>
      </article>`,
        )
        .join("")
    : "<p>Belum ada menu tersimpan. Hasil yang lu simpan muncul di sini.</p>";
}

// Panduan foto: tampil di beranda sebelum unggah, bisa ditutup, dan
// bisa dibuka lagi dari tombol di area upload. Tidak pernah memblokir
// unggah: tombol unggah tetap aktif walau panduan ditutup.
$("guide-close")?.addEventListener("click", () => {
  $("guide").hidden = true;
});
$("guide-reopen")?.addEventListener("click", () => {
  $("guide").hidden = false;
  $("guide").scrollIntoView({ behavior: "smooth", block: "start" });
});

loadCatalog();
