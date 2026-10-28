const $ = (id) => document.getElementById(id);
let current = null;

const esc = (text) =>
  String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

$("photo").addEventListener("change", () => {
  const file = $("photo").files[0];
  if (!file) return;
  const url = URL.createObjectURL(file);
  $("preview").src = url;
  $("preview").hidden = false;
  $("original-image").src = url;
  $("upload-label").textContent = file.name;
  $("process").disabled = false;
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
  const file = $("photo").files[0];
  if (!file) {
    $("status").textContent = "Pilih foto dulu.";
    return;
  }
  $("status").textContent = "Memproses, tunggu sebentar...";
  $("process").disabled = true;
  $("process").querySelector(".spinner").hidden = false;
  try {
    const form = new FormData();
    form.append("photo", file);
    const res = await fetch("/api/process", { method: "POST", body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "proses gagal");
    current = data;
    $("result-image").src = data.imageUrl;
    $("dish").value = data.dish;
    $("cost-min").value = data.costRangeIdr.min;
    $("cost-max").value = data.costRangeIdr.max;
    $("ingredients").value = data.items
      .flatMap((group) =>
        group.ingredients.map(
          (item) => `${group.name} | ${item.name}: ${item.amount}`,
        ),
      )
      .join("\n");
    $("caption").value = data.caption;
    $("result").hidden = false;
    $("result").scrollIntoView({ behavior: "smooth", block: "start" });
    $("status").textContent = "Jadi. Koreksi dulu kalau perlu, lalu simpan.";
  } catch (error) {
    $("status").textContent = error.message;
  } finally {
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
  const items = await (await fetch("/api/catalog")).json();
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
          ${renderItems(item)}
          <p>${esc(item.caption)}</p>
        </div>
      </article>`,
        )
        .join("")
    : "<p>Belum ada menu tersimpan. Hasil yang lu simpan muncul di sini.</p>";
}

loadCatalog();
