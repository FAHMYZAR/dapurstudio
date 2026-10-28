# DapurStudio

Penjual makanan kecil biasanya memotret dagangannya di dapur yang berantakan.
Hasilnya tidak layak katalog, padahal foto katalog yang rapi menaikkan
kepercayaan pembeli. DapurStudio mengubah foto dapur itu menjadi foto katalog,
lengkap dengan estimasi biaya bahan dan caption jualan, dalam satu alur
end-to-end. Penjual memeriksa dan mengoreksi hasilnya sebelum menyimpan.

Dibangun selama Meta Global AI Developer Hackathon 2026, track Indie,
problem statement Build for Your World. Semua kode dan fitur di repo ini
dibuat selama hackathon.

## Alur produk

1. Penjual mengunggah satu foto sajian dari HP.
2. SAM 3.1 memotong objek sajian. Aturan satu set: semua objek sajian yang
   terfoto ikut dipertahankan, tidak ada yang dihapus. Prompt yang dicoba
   paralel lalu mask-nya digabung: "plated food", "plate of fried food",
   "plate of food", "coffee mug", "glass", "cup". Catatan prompt: "plate of
   food" saja hanya memotong cincin piring (makanan jadi lubang), jadi
   prompt perakit hidangan wajib ikut dalam gabungan.
3. Validasi set: mask dikelompokkan berdasarkan kedekatan. Mask terbesar
   menjadi klaster awal, dan hanya mask yang menyentuh klaster (dalam 25
   piksel) yang dipertahankan. Peralatan dapur yang jauh dari sajian, yang
   bisa saja cocok dengan prompt generik seperti "cup", ikut dibuang.
4. Tepi mask diperhalus (erosi 1 piksel, blur 0,8), lalu potongan set
   ditempel di atas template backdrop studio yang sudah divalidasi, dengan
   satu bayangan lunak dari kode. Set dibatasi 82 persen lebar dan 80
   persen tinggi backdrop, aspect ratio dipertahankan.
5. Muse Spark mengidentifikasi seluruh set (makanan dan minuman dipisah per
   item), menyusun bahan utama per item, mengestimasi biaya bahan seluruh
   set sebagai rentang Rupiah, dan menulis caption jualan Bahasa Indonesia.
6. Penjual mengoreksi hidangan, biaya, bahan, dan caption, lalu menyimpan ke
   katalog.

## Teknologi

- Bun (satu server: frontend statis + API + katalog file JSON).
- Python worker (`scripts/image_worker.py`) untuk decode mask SAM dan
  komposit gambar, memakai Pillow dan `meta-sam-parser`.
- Meta Model API: SAM 3.1, Muse Image, Muse Spark.

## Menjalankan

```sh
pip install -r scripts/requirements.txt
cp .env.example .env   # isi META_API_KEY dari dashboard dev.meta.ai
bun run server.ts
```

Buka http://localhost:3000. Kunci API tidak pernah dikirim ke browser;
semua panggilan Meta terjadi di server.

Mode dev lokal tanpa kunci di file: set `META_CLI` ke path helper
`meta.py` dan `META_PYLIBS` ke direktori `meta-sam-parser`, maka server
memakai helper itu untuk panggilan Meta dan worker.

## API

- `GET /api/health`
- `POST /api/process` (form-data field `photo`) → foto katalog, hidangan,
  item sajian beserta bahannya, rentang biaya seluruh set, caption.
- `GET /api/catalog`, `POST /api/catalog` (koreksi seller ikut tersimpan).

## Aset demo

`assets/demo/dapurstudio-catalog-2.png`: sepiring Kue Untir-Untir dan gelas
kopi dari foto dapur berantakan, estimasi biaya bahan Rp 8.000-15.000.

## Catatan lisensi

Dependensi `meta-sam-parser` berada di bawah SAM License dari Meta.
Repo ini sendiri tidak mendistribusikan ulang kode parser tersebut.
