const $ = (id) => document.getElementById(id);
let current = null;
let uploadFile = null;

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

$("photo").addEventListener("change", () => {
  const file = $("photo").files[0];
  if (!file) return;
  $("upload-label").textContent = file.name;
  $("process").disabled = true;
  // Foto HP bisa 7 MB lebih: enam panggilan SAM yang masing-masing mengunggah
  // foto itu sebagai base64 jadi puluhan MB dan prosesnya menggantung sampai
  // koneksi depan diputus. Kecilkan dulu di browser (maks 1600px, JPEG 0.85):
  // cukup untuk katalog, jauh lebih cepat, dan yang diproses sama dengan yang
  // tampil di pratinjau.
  const img = new Image();
  const src = URL.createObjectURL(file);
  img.onload = () => {
    URL.revokeObjectURL(src);
    const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(
      (blob) => {
        uploadFile = blob
          ? new File([blob], file.name, { type: "image/jpeg" })
          : file;
        const url = URL.createObjectURL(uploadFile);
        $("preview").src = url;
        $("preview").hidden = false;
        $("original-image").src = url;
        $("process").disabled = false;
      },
      "image/jpeg",
      0.85,
    );
  };
  img.onerror = () => {
    URL.revokeObjectURL(src);
    uploadFile = file;
    const url = URL.createObjectURL(file);
    $("preview").src = url;
    $("preview").hidden = false;
    $("original-image").src = url;
    $("process").disabled = false;
  };
  img.src = src;
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

loadCatalog();
