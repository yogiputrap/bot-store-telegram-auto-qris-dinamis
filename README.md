# 🤖 Moakun Store Bot — Telegram Auto-Order & Virtual OTP Ecosystem

<p align="center">
  <img src="assets/moakun_banner.jpg" alt="Moakun Store Banner" width="700" style="border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.15);" />
</p>

<p align="center">
  <b>Sistem E-Commerce Telegram Modern & Otomatis 24 Jam dengan Integrasi Dynamic Auto QRIS (CodeGatra), Layanan SMS OTP Virtual (RumahOTP), Dynamic Flash Sale Engine, dan Manajemen Stok Cerdas.</b>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-v20%2B-green?style=for-the-badge&logo=node.js" alt="Node.js" />
  <img src="https://img.shields.io/badge/Database-SQLite3%20WAL%20Mode-blue?style=for-the-badge&logo=sqlite" alt="SQLite" />
  <img src="https://img.shields.io/badge/Deploy-Docker%20%7C%20Dokploy-2496ED?style=for-the-badge&logo=docker" alt="Docker" />
  <img src="https://img.shields.io/badge/Payment-CodeGatra%20Auto%20QRIS-orange?style=for-the-badge" alt="CodeGatra" />
  <img src="https://img.shields.io/badge/OTP%20Provider-RumahOTP%20API-purple?style=for-the-badge" alt="RumahOTP" />
  <img src="https://img.shields.io/badge/License-MIT-brightgreen?style=for-the-badge" alt="License" />
</p>

---

## 📑 Daftar Isi
1. [🌟 Highlight & Keunggulan Utama](#-highlight--keunggulan-utama)
2. [🏗️ Arsitektur & Alur Kerja Sistem](#️-arsitektur--alur-kerja-sistem)
3. [🛍️ Fitur Lengkap User (Pembeli)](#️-fitur-lengkap-user-pembeli)
4. [⚡ Fitur Dynamic Flash Sale](#-fitur-dynamic-flash-sale)
5. [📱 Fitur Layanan OTP Virtual Otomatis](#-fitur-layanan-otp-virtual-otomatis)
6. [👑 Fitur Lengkap Admin & Owner](#-fitur-lengkap-admin--owner)
7. [🛡️ Sistem Keamanan & Proteksi Fraud](#️-sistem-keamanan--proteksi-fraud)
8. [⚙️ Panduan Instalasi & Konfigurasi](#️-panduan-instalasi--konfigurasi)
9. [🐳 Panduan Deployment (Dokploy / Docker Compose)](#-panduan-deployment-dokploy--docker-compose)
10. [📑 Daftar Perintah (Slash Commands)](#-daftar-perintah-slash-commands)
11. [🗄️ Skema Database & Relasi](#️-skema-database--relasi)

---

## 🌟 Highlight & Keunggulan Utama

* ⚡ **100% Fully Automated 24/7**: Pembeli melakukan pembayaran via QRIS / Saldo, dan pesanan akun digital langsung dikirim oleh bot secara instan tanpa perlu campur tangan admin manual.
* 💳 **Auto-Polling QRIS Dinamis (CodeGatra)**: Dilengkapi background worker yang memverifikasi mutasi setiap 5 detik dengan proteksi kode nominal unik anti-fraud.
* 📲 **Otomasi SMS OTP Virtual (RumahOTP)**: Nomor HP virtual langsung muncul setelah order, SMS OTP terdeteksi otomatis tanpa klik tombol berulang, serta dilengkapi **Auto-Refund 100%** jika SMS tidak masuk dalam batas waktu.
* 🔥 **Dynamic Flash Sale System**: Tampilan diskon real-time dari database dengan harga coret (`<s>Rp 30.000</s>`), kalkulasi persentase diskon (`-48%`), dan tombol 1-tap checkout langsung ke metode pembayaran.
* 🛡️ **Zero-Loss Data Persistence**: Menggunakan Docker Named Volumes (`moakun_database` & `moakun_backups`) yang terkunci permanen di level host, aman dari reset container maupun redeployment di Dokploy.
* 📢 **Safe Rate-Limited Broadcast**: Sistem pengiriman pesan siaran massal dengan kontrol kecepatan antrean (25 pesan/detik) untuk melindungi bot dari hukuman *Telegram Flood Wait* / Banned.
* ⌨️ **Persistent Menu Bar (Reply Keyboard)**: Desain UX modern di mana menu bawah Telegram tetap standby dan tidak pernah collapse atau menghilang secara tidak sengaja.
* ✨ **Smooth Animated Loading Transition (Auto-Delete)**: Efek transisi interaktif progress bar saat user mengetik `/start` yang otomatis terhapus bersih dalam hitungan detik tanpa menyisakan sampah chat.

---

## 🏗️ Arsitektur & Alur Kerja Sistem

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           PEMBELI (TELEGRAM)                            │
└──────────────┬────────────────────────────┬─────────────────────────────┘
               │                            │
   [1] Pilih Produk / Flash Sale    [2] Order OTP Virtual
               │                            │
               ▼                            ▼
┌──────────────────────────────┐ ┌──────────────────────────────────────┐
│       CHECKOUT ENGINE        │ │          OTP SERVICE ENGINE          │
│  - Potong Voucher Diskon     │ │  - Request No HP via RumahOTP API    │
│  - Generate Kode Unik QRIS   │ │  - Potong Saldo Akun User            │
└──────────────┬───────────────┘ └──────────────────┬───────────────────┘
               │                                    │
               ├─────────────────┬──────────────────┘
               │                 │
               ▼                 ▼
┌──────────────────────────────┐ ┌──────────────────────────────────────┐
│     PAYMENT GATEWAY QRIS     │ │       RUMAHOTP POLLING WORKER        │
│  - CodeGatra Dynamic API     │ │  - Background Poller (Tiap 5 Detik)  │
│  - Polling Worker (Tiap 5s)  │ │  - SMS Masuk ➔ Kirim ke Pembeli      │
│  - Settlement 0-Detik        │ │  - Timeout ➔ Auto Refund Saldo       │
└──────────────┬───────────────┘ └──────────────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      AUTO FULFILLMENT & INVENTORY                       │
│  - SQLite Database (WAL Mode) Atomic Transaction                        │
│  - Ambil Stok Akun ➔ Kirim Instan ke Chat Pembeli                       │
│  - Simpan ke Riwayat Pembelian & Catat Mutasi Finansial                 │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 🛍️ Fitur Lengkap User (Pembeli)

| Fitur | Deskripsi Detail |
| :--- | :--- |
| **🛍️ Katalog Cerdas (Smart Catalog)** | Menampilkan seluruh kategori produk aktif dengan pagination otomatis, rentang harga terendah-tertinggi, dan jumlah varian yang tersedia. |
| **🔍 Pencarian Cepat (Live Search)** | Mencari produk berdasarkan kata kunci (keyword) nama varian tanpa perlu membuka halaman katalog satu per satu. |
| **📦 Pembelian Grosir (Bulk Purchase)** | Pilihan cepat beli 1 pcs, 2 pcs, 3 pcs, 5 pcs, 10 pcs, atau input jumlah custom sesuai kebutuhan reseller. |
| **💳 Pembayaran Ganda** | Pembeli dapat memilih membayar menggunakan **Saldo Akun** atau langsung scan **Dynamic QRIS (Semua E-Wallet & Mobile Banking)**. |
| **🎟️ Kupon & Voucher Diskon** | Pembeli dapat memasukkan kode promo saat checkout untuk mendapatkan potongan harga langsung sesuai syarat minimum belanja. |
| **📜 Riwayat Transaksi Digital** | Menyimpan seluruh arsip pesanan akun (*Email, Password, Extra Info, Link*) dan pesanan OTP (*Nomor HP, SMS OTP*) secara rapi dan permanen. |
| **💰 Deposit Saldo Instan** | Top-up saldo mandiri dengan QRIS otomatis 24 Jam. Nominal unik ditambahkan dan saldo otomatis masuk dalam hitungan detik. |
| **🛡️ Klaim Garansi Terintegrasi** | Form pengajuan garansi akun bermasalah dengan format `KODE_ORDER \| KELUHAN`. Tiket dibuat di sistem dan langsung meneruskan alert ke Telegram Owner. |
| **✨ Smooth Animated Loader** | Animasi loading bar interaktif saat `/start` (`[ ▰▰▰▱▱▱ ] 30%` ➔ `[ ▰▰▰▰▰▰ ] 100%`) yang otomatis lenyap setelah selesai untuk pengalaman pengguna yang mulus. |
| **📢 Channel Gate (Force Subscribe)** | Pengunjung wajib bergabung ke channel informasi toko sebelum dapat melakukan transaksi (dapat diaktifkan/dinonaktifkan). |

---

## ⚡ Fitur Dynamic Flash Sale

Menu Flash Sale dirancang khusus untuk meningkatkan konversi penjualan toko dengan tampilan yang menarik dan interaktif:

```text
⚡ FLASH SALE PRODUK Moakun Store
━━━━━━━━━━━━━━━━━━━━━━
Pilih produk flash sale di bawah untuk membeli dengan harga diskon:

[1] 🔥 LINK REDEM GEMINI 3 BULAN
   └ 💰 Rp 25.000 ➜ Rp 13.000 (-48%)

[2] 🔥 GEMINI HEAD AKUN 3 BULAN
   └ 💰 Rp 45.000 ➜ Rp 35.000 (-22%)

[3] 🔥 CAPCUT PRO 1 BULAN
   └ 💰 Rp 35.000 ➜ Rp 25.000 (-28%)

[4] 🔥 YOUTUBE PREMIUM 12 BULAN
   └ 💰 Rp 30.000 ➜ Rp 15.000 (-50%)

━━━━━━━━━━━━━━━━━━━━━━
👉 Cara Beli: Klik tombol produk di bawah sebelum promo berakhir!
⚠️ Stok terbatas! Segera pesan sebelum kehabisan.
```

### Keunggulan Flash Sale:
* **100% Real-Time Database**: Setiap produk berkategori `⚡ FLASH SALE` yang ditambahkan admin langsung tampil otomatis tanpa perlu ubah source code.
* **Kalkulasi Diskon Otomatis**: Menghitung persentase diskon `(-X%)` secara presisi dari selisih `original_price` dan `price`.
* **1-Tap Direct Checkout**: Mengklik tombol produk Flash Sale langsung membuka rincian akun dan opsi pembayaran (Saldo / QRIS).
* **Navigasi Bersih**: Dilengkapi tombol kembali yang langsung mengarahkan user kembali ke menu Flash Sale.

---

## 📱 Fitur Layanan OTP Virtual Otomatis

Integrasi langsung dengan gateway provider **RumahOTP API**:

1. **Pilihan Aplikasi Populer**: WhatsApp, Telegram, Google, TikTok, Shopee, Gojek, Grab, Dana, Ovo, Facebook, Instagram, Twitter, dll.
2. **Auto Refresh Stock & Harga**: Harga layanan OTP diambil real-time dari provider ditambah margin profit yang dikonfigurasi admin.
3. **Background Worker Polling**: Bot mengecek status SMS setiap 5 detik secara asynchronous di background.
4. **Auto-Timeout & Auto-Refund 100%**: Jika provider tidak mengirimkan SMS OTP dalam batas waktu (biasanya 2-5 menit), pesanan otomatis berstatus `expired` dan saldo pembeli dikembalikan 100% ke akunnya.
5. **Pembatalan Manual**: Pembeli dapat membatalkan pesanan kapan saja sebelum SMS masuk dan mendapatkan pengembalian saldo instan.

---

## 👑 Fitur Lengkap Admin & Owner

Panel admin dapat diakses melalui perintah `/admin` dengan autentikasi aman berbasis Telegram ID:

<p align="center">
  <img src="https://img.shields.io/badge/Panel%20Admin-Multi--Role%20RBAC-informational?style=flat-square" alt="Admin RBAC" />
</p>

### 1. ➕ Tambah Produk Cerdas (Smart Add Product)
Saat klik tombol `➕ Add Product`, admin diberikan 2 pilihan tipe produk via tombol interaktif:
* **`[ 📦 Reguler Product ]`**: Input Kategori Reguler ➔ Nama Variasi ➔ Harga Jual ➔ Deskripsi.
* **`[ ⚡ FLASH SALE ]`**: Kategori otomatis disetel ke `⚡ FLASH SALE` ➔ Nama Variasi ➔ **Harga Awal/Normal (Coret)** ➔ **Harga Promo Flash Sale** ➔ Deskripsi.

### 2. 📥 Manajemen Stok Akun Multi-Metode
* **Input Manual Cepat (Single / Multi-Line)**:
  Format per baris: `email|password` atau `email|password|extra_data` atau `link_redeem|garansi`.
* **Import File `.txt` (Bulk TXT Engine)**:
  Admin cukup mengunggah file `.txt`. Bot akan menganalisa total baris, jumlah akun valid, format error, dan akun duplikat sebelum melakukan batch insertion ke database.

### 3. 🎟️ Manajemen Voucher Promo Fleksibel
* **Input Direct Pipe di Chat Kapan Saja**:
  ```text
  KODE_VOUCHER | POTONGAN_HARGA | MINIMUM_BELANJA | KUOTA_PENGGUNAAN
  ```
  *Contoh:* `DISKON10K | 10000 | 50000 | 25` (Diskon Rp 10.000, Min. Belanja Rp 50.000, untuk 25 user pertama).
* **Monitoring & Delete**: Melihat sisa kuota yang terpakai dan menghapus voucher aktif dengan 1 klik.

### 4. 💳 Direct Saldo Adjuster
Admin dapat menambah / mengurangi saldo user langsung melalui chat dengan format:
```text
TELEGRAM_ID | JUMLAH_SALDO
```
*Contoh:* `123456789 | 50000` (Menambahkan saldo Rp 50.000 ke akun target).

### 5. 📢 Rate-Limited Broadcast Engine
Kirim pesan siaran teks HTML atau foto ber-caption ke seluruh member dengan aman tanpa risiko banned dari Telegram:
* Dilengkapi antrean *throttling* 25 pesan/detik.
* Laporan progres pengiriman dan statistik berhasil/gagal secara transparan.

### 6. 📊 Export Laporan Penjualan (CSV)
Generate file `.csv` laporan transaksi toko dalam 1 klik, berisi ID order, nama produk, kategori, jumlah, harga, metode bayar, status, username pembeli, dan tanggal transaksi.

### 7. 💾 Sistem Backup Database (Manual & Auto)
* Perintah `/backup` mengirimkan file arsip `.zip` database terkompresi langsung ke chat admin.
* Background scheduler melakukan backup otomatis berkala ke direktori `/app/backups/`.

---

## 🛡️ Sistem Keamanan & Proteksi Fraud

| Lapisan Keamanan | Implementasi & Proteksi |
| :--- | :--- |
| **Role-Based Access Control (RBAC)** | Pengecekan multi-tier `isAdmin(fromId)` memverifikasi `role` database, `OWNER_ID`, dan daftar `ADMIN_IDS` dari file `.env`. |
| **Anti-SQL Injection** | 100% Prepared Statements (`?` parameter binding) pada semua query SQLite native maupun library fallback. |
| **Anti-Fraud QRIS Pricing** | Penambahan kode acak unik pada setiap tagihan QRIS mencegah manipulasi mutasi dan double-claim. |
| **Voucher Single-Use Enforcement** | Tabel `voucher_usages` mencatat kombinasi unik `(voucher_id, user_id)` sehingga 1 akun Telegram hanya bisa mengklaim kode promo 1 kali. |
| **Atomic Inventory Concurrency** | Transaksi database ACID (`BEGIN TRANSACTION ... COMMIT`) mengunci stok saat checkout agar tidak terjadi *race condition* atau *overselling*. |
| **Anti-Flood Broadcast Queue** | Pengiriman siaran masal dibagi per batch 25-30 request/detik untuk menghindari error `429 Too Many Requests`. |
| **Sanitized Markup Handler** | Pembersihan otomatis tombol inline kosong untuk mencegah crash pada antarmuka Telegram Bot API. |

---

## ⚙️ Panduan Instalasi & Konfigurasi

### 1. Kloning Repositori
```bash
git clone https://github.com/yogiputrap/bot-store-telegram-auto-qris-dinamis.git
cd bot-store-telegram-auto-qris-dinamis
```

### 2. Konfigurasi Environment (`.env`)
Buat file `.env` di root direktori proyek:

```env
# === TELEGRAM BOT CREDENTIALS ===
BOT_TOKEN=1234567890:ABCdefGhIJKlmNoPQRsTUVwxyZ
OWNER_ID=8915677989
ADMIN_IDS=8915677989,123456789

# === IDENTITAS TOKO ===
STORE_NAME="Moakun Store"
STORE_USERNAME=moakun_bot
SUPPORT_USERNAME=yopratama
CHANNEL_ID=@moakun_channel
CHANNEL_URL=https://t.me/moakun_channel
GROUP_URL=https://t.me/moakun_group

# === CODEGATRA AUTO QRIS GATEWAY ===
CODEGATRA_BASE_URL=https://pay.codegatra.com/api
CODEGATRA_API_KEY=your_codegatra_api_key
CODEGATRA_NAMA_PROJECT=your_project_name
CODEGATRA_EXPIRED_MINUTES=10
STATIC_QRIS=00020101021126670016ID.CO.QRIS.WWW...

# === RUMAHOTP VIRTUAL SMS GATEWAY ===
RUMAHOTP_API_KEY=rk-dev-xxxx
RUMAHOTP_BASE_URL=https://www.rumahotp.io
OTP_PROFIT_MARGIN=1500

# === PENGATURAN UMUM ===
CURRENCY=Rp
MIN_DEPOSIT=10000
ITEMS_PER_PAGE=6
AUTO_BACKUP_HOURS=24
```

### 3. Menjalankan secara Lokal
```bash
# Install dependencies
npm install --build-from-source

# Jalankan bot
npm start
```

---

## 🐳 Panduan Deployment (Dokploy / Docker Compose)

Proyek ini telah dikonfigurasi dengan **Docker Compose** dan **Named Volumes permanen** untuk deployment produksi zero-downtime:

### File `docker-compose.yml`:
```yaml
services:
  moakun-store-bot:
    build:
      context: .
      dockerfile: Dockerfile
    restart: unless-stopped
    env_file:
      - .env
    environment:
      - NODE_ENV=production
      - TZ=Asia/Jakarta
    volumes:
      - moakun_database:/app/database
      - moakun_backups:/app/backups
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"

volumes:
  moakun_database:
    name: moakun_database
    external: true
  moakun_backups:
    name: moakun_backups
    external: true
```

### Langkah Deployment di Dokploy:
1. Buat Service bertipe **Compose** di Dokploy Dashboard.
2. Hubungkan ke repositori GitHub `bot-store-telegram-auto-qris-dinamis` (Branch `main`).
3. Tambahkan environment variables di tab **Environment**.
4. Klik **Deploy**! Docker Compose akan membangun image container dan menempelkannya ke volume data `moakun_database` secara otomatis tanpa konflik nama container.

---

## 📑 Daftar Perintah (Slash Commands)

### 👤 Perintah Pembeli (User)
| Command | Fungsi |
| :--- | :--- |
| `/start` | Membuka Dashboard Utama toko dan memunculkan menu navigasi. |
| `/katalog` | Membuka katalog produk aktif dengan fitur navigasi halaman. |
| `/flashsale` | Membuka menu promo Flash Sale dengan diskon coret dan tombol direct-buy. |
| `/saldo` | Memeriksa saldo dompet akun dan panduan deposit instan. |
| `/riwayat` | Melihat riwayat transaksi pembelian akun dan layanan OTP. |
| `/bantuan` | Menampilkan informasi kontak bantuan customer support toko. |

### 👑 Perintah Admin & Owner
| Command | Fungsi |
| :--- | :--- |
| `/admin` | Membuka Panel Kontrol Admin (Manajemen Produk, Stok, Voucher, Broadcast). |
| `/backup` | Membuat arsip ZIP database SQLite dan mengirimkannya ke chat admin. |
| `/export` | Mengunduh file CSV seluruh data transaksi penjualan toko. |

---

## 🗄️ Skema Database & Relasi

Aplikasi menggunakan SQLite berkemampuan tinggi dengan tabel-tabel terstruktur:

* `users`: Data akun Telegram pembeli, username, nama, role (`user`/`admin`/`owner`), dan saldo dompet (`balance`).
* `products`: Daftar produk digital, nama kategori, nama variasi, harga jual (`price`), harga normal (`original_price`), deskripsi, dan status.
* `product_stock`: Data kredensial inventaris akun (`email`, `password`, `extra_data`, status `available`/`sold`).
* `orders`: Log pesanan produk digital, kode order unik, kuantiti, total bruto, potongan diskon, kode voucher, dan status pembayaran.
* `payments`: Data transaksi QRIS CodeGatra, kode referensi unik, jumlah transfer, URL gambar QR, dan batas waktu kedaluwarsa.
* `deposits`: Data riwayat top-up saldo user via QRIS otomatis.
* `otp_orders`: Data pesanan nomor HP virtual RumahOTP, nama aplikasi, nomor telepon, kode OTP masuk, dan status verifikasi.
* `vouchers`: Konfigurasi kode kupon promo, besaran potongan, syarat minimum belanja, batas kuota pemakaian, dan jumlah terpakai.
* `voucher_usages`: Rekam jejak klaim voucher per user ID untuk mencegah penyalahgunaan ganda.
* `balance_history`: Buku kas mutasi saldo akun (Deposit, Pembelian Produk, Order OTP, Refund).
* `support_tickets`: Tiket pengaduan keluhan dan klaim garansi pembeli.

---

## 📄 Lisensi

Proyek ini dirilis di bawah lisensi [MIT License](LICENSE).

<p align="center">
  <b>Developed with ❤️ for High-Performance Digital E-Commerce Operations.</b>
</p>
