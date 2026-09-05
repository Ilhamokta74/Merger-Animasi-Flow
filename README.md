# Video Merger

Menggabungkan potongan video per folder di dalam `input/`, dengan progress bar
dan estimasi waktu (ETA) untuk setiap "judul" (nama folder).

## Struktur folder

```
input/
  Judul A/
    part1.mp4
    part2.mp4
  Judul B/
    clip1.mp4
    clip2.mp4
```

Hasilnya akan tersimpan otomatis di:

```
output/
  Judul A.mp4
  Judul B.mp4
```

Urutan penggabungan mengikuti urutan nama file secara alami (natural sort),
jadi `part2.mp4` akan digabung sebelum `part10.mp4`.

## Persiapan

1. Install [ffmpeg](https://ffmpeg.org/download.html) di komputer kamu dan
   pastikan bisa dipanggil dari terminal:
   ```
   ffmpeg -version
   ```
2. Install dependency Node.js:
   ```
   npm install
   ```

## Menjalankan

Taruh video kamu di dalam `input/<nama folder>/`, lalu jalankan:

```
npm start
```

atau

```
node index.js
```

Kamu akan melihat progress bar per folder seperti ini:

```
Judul A              |████████████████░░░░| 78% | 156s/200s | ETA: 12s | memproses
Judul B              |░░░░░░░░░░░░░░░░░░░░|  0% | 0s/340s   | ETA: N/A | menunggu
```

## Konfigurasi (di dalam index.js)

- `CONCURRENCY` — jumlah folder yang diproses bersamaan. Default `1`
  (satu-satu, paling stabil). Naikkan kalau CPU/disk kamu kuat dan mau lebih
  cepat memproses banyak judul sekaligus.
- `FADE` — fade in/out otomatis antar part dalam satu folder:
  - `enabled: true` (default) — part pertama hanya fade-out di akhir, part
    terakhir hanya fade-in di awal, part di tengah dapat fade-in DAN
    fade-out. Kalau folder cuma berisi 1 file, tidak ada fade sama sekali.
    Video aslinya **diputar penuh dulu tanpa diredupkan sama sekali** —
    fade dilakukan dengan menambah waktu ekstra (frame terakhir/pertama
    dibekukan lalu difade), jadi durasi hasil akhir sedikit lebih panjang
    dari total durasi asli (bertambah `duration` detik per sisi fade).
    Mode ini SELALU re-encode (butuh proses ulang gambar+audio), jadi lebih
    lambat dari mode copy.
  - `duration: 1` — lama tambahan waktu fade dalam detik di tiap sisi.
  - `enabled: false` — matikan fade sepenuhnya, kembali pakai `MODE` di bawah.
- `MODE` (hanya dipakai kalau `FADE.enabled = false`):
  - `'copy'` (default) — cepat, tanpa re-encode ulang. Cocok kalau semua
    potongan video dalam satu folder punya codec/resolusi/format yang sama
    (misalnya semua berasal dari kamera/rekaman yang sama). Kalau gagal
    (karena codec berbeda), script otomatis fallback ke re-encode.
  - `'reencode'` — selalu re-encode pakai libx264/aac. Lebih lambat, tapi
    aman walau video di satu folder punya codec/resolusi berbeda-beda.

## Catatan

- Ekstensi video yang dikenali: `.mp4 .mov .mkv .avi .ts .webm .m4v` — bisa
  ditambah di array `VIDEO_EXT` dalam `index.js`.
- Folder yang tidak berisi video otomatis dilewati.
- Jika satu folder gagal diproses, script akan lanjut ke folder lain dan
  menampilkan ringkasan error di akhir.
