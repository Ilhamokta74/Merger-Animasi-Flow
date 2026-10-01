/**
 * upscale.js
 *
 * Upscale semua video di folder ./output ke Full HD, dengan deteksi
 * orientasi otomatis per video:
 *   - Portrait  -> 1080x1920
 *   - Landscape -> 1920x1080
 * Hasil disimpan di ./output_1080 (nama file sama).
 *
 * Pakai Lanczos scaling + sharpening supaya tidak blur. Aspect ratio
 * dijaga (tidak di-stretch); kalau tidak pas, sisanya diberi bar hitam.
 *
 * Kebutuhan:
 *   1. Node.js
 *   2. FFmpeg (+ ffprobe) ada di PATH
 *   3. npm install fluent-ffmpeg
 *
 * Jalankan:
 *   node upscale.js              -> otomatis per video (portrait/landscape)
 *   node upscale.js 1280 720     -> paksa SEMUA video ke ukuran ini
 */

const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');

// ---- CONFIG -----------------------------------------------------------
const INPUT_DIR = path.resolve(__dirname, 'output');
const OUTPUT_DIR = path.resolve(__dirname, 'output_1080');
const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.mkv', '.webm', '.avi'];

// Ukuran otomatis: sisi pendek x sisi panjang
const SHORT_SIDE = 1080;
const LONG_SIDE = 1920;

// Lewati file yang hasilnya sudah ada di OUTPUT_DIR
const SKIP_EXISTING = true;

// SHARPEN_AMOUNT: 0.6-1.2 = aman/natural. Di atas 2 muncul artefak halo.
const SHARPEN_AMOUNT = 0.8;

// Kalau argumen width & height diberikan, ukuran itu dipakai untuk semua video
const [, , widthArg, heightArg] = process.argv;
const FORCED_WIDTH = parseInt(widthArg, 10) || 0;
const FORCED_HEIGHT = parseInt(heightArg, 10) || 0;
const FORCE_SIZE = FORCED_WIDTH > 0 && FORCED_HEIGHT > 0;

// ---- HELPERS ------------------------------------------------------------
function naturalSort(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

function ensureDirs() {
  for (const dir of [INPUT_DIR, OUTPUT_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}

function getVideoFiles() {
  return fs
    .readdirSync(INPUT_DIR)
    .filter((f) => VIDEO_EXTENSIONS.includes(path.extname(f).toLowerCase()))
    .sort(naturalSort);
}

// Baca dimensi video (sudah memperhitungkan metadata rotasi)
function getDimensions(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) return reject(err);
      const vs = (data.streams || []).find((s) => s.codec_type === 'video');
      if (!vs) return resolve({ width: 0, height: 0 });

      const sideRotation =
        vs.side_data_list && vs.side_data_list.find((d) => d.rotation !== undefined);
      const rotation = Math.abs(
        parseInt((vs.tags && vs.tags.rotate) || (sideRotation && sideRotation.rotation) || 0, 10)
      );

      let { width, height } = vs;
      if (rotation === 90 || rotation === 270) [width, height] = [height, width];
      resolve({ width: width || 0, height: height || 0 });
    });
  });
}

// Tentukan ukuran target berdasarkan orientasi video
function pickTarget({ width, height }) {
  if (FORCE_SIZE) return { width: FORCED_WIDTH, height: FORCED_HEIGHT, label: 'manual' };
  if (width > height) return { width: LONG_SIDE, height: SHORT_SIDE, label: 'landscape' };
  return { width: SHORT_SIDE, height: LONG_SIDE, label: 'portrait' };
}

/**
 * Filter chain:
 * 1. scale   -> Lanczos (kualitas upscale terbaik, tidak soft seperti bilinear/bicubic)
 * 2. pad     -> jaga aspect ratio (tidak di-stretch), sisa diberi bar hitam
 * 3. setsar  -> pastikan pixel aspect ratio 1:1
 * 4. unsharp -> kembalikan ketajaman tepi yang hilang saat upscale
 */
function buildFilterChain(width, height) {
  return [
    `scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos`,
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`,
    'setsar=1',
    `unsharp=5:5:${SHARPEN_AMOUNT}:5:5:0.0`,
  ].join(',');
}

function upscaleVideo(inputPath, outputPath, width, height) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .videoFilters(buildFilterChain(width, height))
      .videoCodec('libx264')
      .outputOptions([
        '-preset slow', // kompresi lebih efisien = kualitas lebih baik di bitrate sama
        '-crf 18',      // nyaris lossless secara visual (makin kecil = makin bagus)
        '-pix_fmt yuv420p',
        '-movflags +faststart',
      ])
      .audioCodec('aac')
      .audioBitrate('192k')
      .on('progress', (p) => {
        if (p.percent) process.stdout.write(`\r  Progress: ${Math.min(p.percent, 100).toFixed(1)}%`);
      })
      .on('error', (err) => reject(err))
      .on('end', () => {
        process.stdout.write('\r  Progress: 100.0%\n');
        resolve(outputPath);
      })
      .save(outputPath);
  });
}

// ---- MAIN ---------------------------------------------------------------
async function main() {
  ensureDirs();
  const files = getVideoFiles();

  if (files.length === 0) {
    console.log(`Tidak ada video di ${INPUT_DIR}`);
    return;
  }

  console.log(
    `Ditemukan ${files.length} video. Mode: ${
      FORCE_SIZE ? `manual ${FORCED_WIDTH}x${FORCED_HEIGHT}` : 'otomatis (portrait/landscape)'
    }\n`
  );

  const errors = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const counter = `[${i + 1}/${files.length}]`;
    const inputPath = path.join(INPUT_DIR, file);
    const outputPath = path.join(OUTPUT_DIR, file);

    if (SKIP_EXISTING && fs.existsSync(outputPath)) {
      console.log(`${counter} ${file} -> dilewati (sudah ada)`);
      continue;
    }

    try {
      const dims = await getDimensions(inputPath);
      const target = pickTarget(dims);
      console.log(
        `${counter} ${file} (${dims.width}x${dims.height}, ${target.label}) -> ${target.width}x${target.height}`
      );
      await upscaleVideo(inputPath, outputPath, target.width, target.height);
    } catch (err) {
      console.error(`\n  Gagal: ${file} -> ${err.message}`);
      // hapus file setengah jadi supaya tidak ter-skip saat dijalankan ulang
      fs.rmSync(outputPath, { force: true });
      errors.push({ file, error: err.message });
    }
  }

  console.log(`\nSelesai. Hasil ada di ${OUTPUT_DIR}`);
  if (errors.length > 0) {
    console.log('\nBeberapa file gagal:');
    errors.forEach((e) => console.log(`- ${e.file}: ${e.error}`));
  }
}

main();
