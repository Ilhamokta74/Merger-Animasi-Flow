/**
 * upscale-ai.js
 *
 * Upscale semua video di ./output ke Full HD memakai Real-ESRGAN (AI),
 * dengan deteksi orientasi otomatis per video:
 *   - Portrait  -> 1080x1920
 *   - Landscape -> 1920x1080
 * Hasil disimpan di ./output_1080 (nama file sama).
 *
 * Alur per video:
 *   1. Ekstrak frame (JPG kualitas tinggi) dengan FFmpeg
 *   2. Upscale x2 tiap frame dengan realesrgan-ncnn-vulkan (GPU)
 *   3. Rakit ulang + perkecil ke 1080p (Lanczos) + audio asli -> H.264
 *
 * Kebutuhan:
 *   1. Node.js
 *   2. FFmpeg (+ ffprobe) ada di PATH
 *   3. npm install fluent-ffmpeg
 *   4. realesrgan-ncnn-vulkan (unduh dari
 *      https://github.com/xinntao/Real-ESRGAN/releases -> versi "ncnn-vulkan"
 *      sesuai OS, extract ke folder ./realesrgan di sebelah script ini)
 *
 * Jalankan:
 *   node upscale-ai.js              -> otomatis per video (portrait/landscape)
 *   node upscale-ai.js 1280 720     -> paksa SEMUA video ke ukuran ini
 *
 * Catatan disk: video 100 detik @24fps = ~2400 frame. Siapkan ruang kosong
 * sekitar 5-10 GB untuk file sementara (otomatis dihapus setelah selesai).
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const ffmpeg = require('fluent-ffmpeg');

// ---- CONFIG -----------------------------------------------------------
const INPUT_DIR = path.resolve(__dirname, 'output');
const OUTPUT_DIR = path.resolve(__dirname, 'output_1080');
const TEMP_DIR = path.resolve(__dirname, 'temp_frames');
const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.mkv', '.webm', '.avi'];

// Lokasi Real-ESRGAN (folder hasil extract; di dalamnya ada folder "models")
const REALESRGAN_DIR = path.resolve(__dirname, 'realesrgan');
const REALESRGAN_BIN = path.join(
  REALESRGAN_DIR,
  process.platform === 'win32' ? 'realesrgan-ncnn-vulkan.exe' : 'realesrgan-ncnn-vulkan'
);

// Model: 'realesr-animevideov3' cocok untuk animasi/kartun 3D.
// Kalau hasilnya terlalu halus/seperti lukisan, coba 'realesr-general-x4v3'.
const MODEL = 'realesr-animevideov3';
const AI_SCALE = 2; // 720p -> 1440p, lalu diperkecil ke 1080p (hasil lebih bersih)

// ID GPU Vulkan. Di laptop dengan GPU ganda (Intel + NVIDIA), ID 0 bisa jadi
// GPU Intel yang lambat. Jalankan realesrgan-ncnn-vulkan sekali tanpa argumen
// untuk melihat daftar GPU, lalu isi ID RTX 3060 di sini. null = otomatis.
const GPU_ID = null;

// Thread load:proc:save. "1:2:2" aman untuk VRAM 6 GB.
const THREADS = '1:2:2';

// Ukuran target otomatis: sisi pendek x sisi panjang
const SHORT_SIDE = 1080;
const LONG_SIDE = 1920;

const CRF = 16;                 // makin kecil = makin bagus (16 = nyaris lossless)
const X264_PRESET = 'slow';
const SKIP_EXISTING = true;     // lewati file yang hasilnya sudah ada
const KEEP_TEMP = false;        // true = simpan frame sementara (untuk debug)

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

// Baca dimensi (sudah memperhitungkan rotasi) dan frame rate
function probeVideo(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) return reject(err);
      const vs = (data.streams || []).find((s) => s.codec_type === 'video');
      if (!vs) return reject(new Error('Tidak ada stream video'));

      const sideRotation =
        vs.side_data_list && vs.side_data_list.find((d) => d.rotation !== undefined);
      const rotation = Math.abs(
        parseInt((vs.tags && vs.tags.rotate) || (sideRotation && sideRotation.rotation) || 0, 10)
      );

      let { width, height } = vs;
      if (rotation === 90 || rotation === 270) [width, height] = [height, width];

      const fps = vs.avg_frame_rate && vs.avg_frame_rate !== '0/0' ? vs.avg_frame_rate : vs.r_frame_rate;
      resolve({ width: width || 0, height: height || 0, fps: fps || '24/1' });
    });
  });
}

function pickTarget({ width, height }) {
  if (FORCE_SIZE) return { width: FORCED_WIDTH, height: FORCED_HEIGHT, label: 'manual' };
  if (width > height) return { width: LONG_SIDE, height: SHORT_SIDE, label: 'landscape' };
  return { width: SHORT_SIDE, height: LONG_SIDE, label: 'portrait' };
}

function rmDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// Langkah 1: ekstrak semua frame
function extractFrames(inputPath, framesDir) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .noAudio()
      .outputOptions(['-q:v 1', '-fps_mode passthrough'])
      .on('error', reject)
      .on('end', resolve)
      .save(path.join(framesDir, 'f_%06d.jpg'));
  });
}

// Langkah 2: upscale AI semua frame di folder
function aiUpscaleFrames(framesDir, outDir) {
  return new Promise((resolve, reject) => {
    const args = [
      '-i', framesDir,
      '-o', outDir,
      '-n', MODEL,
      '-s', String(AI_SCALE),
      '-f', 'jpg',
      '-j', THREADS,
      '-m', path.join(REALESRGAN_DIR, 'models'),
    ];
    if (GPU_ID !== null) args.push('-g', String(GPU_ID));

    const total = fs.readdirSync(framesDir).length;
    const startedAt = Date.now();
    const proc = spawn(REALESRGAN_BIN, args, { windowsHide: true });

    // Progres nyata: hitung jumlah frame hasil upscale yang sudah jadi
    const timer = setInterval(() => {
      let done = 0;
      try { done = fs.readdirSync(outDir).length; } catch (e) { /* abaikan */ }
      const sec = (Date.now() - startedAt) / 1000;
      const fps = done / Math.max(sec, 1);
      const eta = fps > 0 ? Math.round((total - done) / fps) : 0;
      process.stdout.write(
        `\r  AI upscale: ${done}/${total} frame (${((done / total) * 100).toFixed(1)}%) | ` +
          `${fps.toFixed(2)} frame/dtk | sisa ~${Math.floor(eta / 60)}m ${eta % 60}s   `
      );
    }, 2000);

    // Tampilkan daftar GPU yang terdeteksi (sekali saja) supaya kelihatan yang dipakai
    let gpuLogged = false;
    let stderrBuf = '';
    proc.stderr.on('data', (chunk) => {
      if (gpuLogged) return;
      stderrBuf += chunk.toString();
      const lines = stderrBuf.split(/\r?\n/).filter((l) => /^\[\d+ .+\]/.test(l.trim()));
      if (lines.length > 0 && stderrBuf.length > 200) {
        gpuLogged = true;
        console.log('\n  GPU terdeteksi:');
        lines.forEach((l) => console.log(`    ${l.trim().split('  ')[0]}`));
      }
    });
    proc.on('error', (err) => {
      clearInterval(timer);
      reject(new Error(`Gagal menjalankan Real-ESRGAN (${REALESRGAN_BIN}): ${err.message}`));
    });
    proc.on('close', (code) => {
      clearInterval(timer);
      process.stdout.write('\n');
      if (code === 0) resolve();
      else reject(new Error(`Real-ESRGAN berhenti dengan kode ${code}`));
    });
  });
}

// Langkah 3: rakit ulang, perkecil ke target, gabung audio asli
function assemble(upscaledDir, originalPath, outputPath, fps, width, height) {
  const vf = [
    `scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos`,
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`,
    'setsar=1',
  ].join(',');

  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(path.join(upscaledDir, 'f_%06d.jpg'))
      .inputOptions([`-framerate ${fps}`])
      .input(originalPath)
      .outputOptions([
        '-map 0:v:0',
        '-map 1:a:0?', // audio opsional (tidak error kalau video tanpa audio)
        '-c:v libx264',
        `-preset ${X264_PRESET}`,
        `-crf ${CRF}`,
        '-pix_fmt yuv420p',
        '-c:a aac',
        '-b:a 192k',
        '-shortest',
        '-movflags +faststart',
      ])
      .videoFilters(vf)
      .on('progress', (p) => {
        if (p.percent) process.stdout.write(`\r  Encode: ${Math.min(p.percent, 100).toFixed(1)}%   `);
      })
      .on('error', reject)
      .on('end', () => {
        process.stdout.write('\r  Encode: 100.0%   \n');
        resolve();
      })
      .save(outputPath);
  });
}

async function processVideo(file, counter) {
  const inputPath = path.join(INPUT_DIR, file);
  const outputPath = path.join(OUTPUT_DIR, file);

  const info = await probeVideo(inputPath);
  const target = pickTarget(info);
  console.log(
    `${counter} ${file} (${info.width}x${info.height}, ${target.label}) -> ${target.width}x${target.height}`
  );

  const workDir = path.join(TEMP_DIR, path.parse(file).name);
  const framesDir = path.join(workDir, 'in');
  const upDir = path.join(workDir, 'up');
  rmDir(workDir);
  fs.mkdirSync(framesDir, { recursive: true });
  fs.mkdirSync(upDir, { recursive: true });

  try {
    console.log('  Ekstrak frame...');
    await extractFrames(inputPath, framesDir);
    await aiUpscaleFrames(framesDir, upDir);
    await assemble(upDir, inputPath, outputPath, info.fps, target.width, target.height);
  } catch (err) {
    fs.rmSync(outputPath, { force: true }); // jangan tinggalkan file setengah jadi
    throw err;
  } finally {
    if (!KEEP_TEMP) rmDir(workDir);
  }
}

// ---- MAIN ---------------------------------------------------------------
async function main() {
  if (!fs.existsSync(REALESRGAN_BIN)) {
    console.error(
      `Real-ESRGAN tidak ditemukan di:\n  ${REALESRGAN_BIN}\n\n` +
        'Unduh versi ncnn-vulkan dari https://github.com/xinntao/Real-ESRGAN/releases\n' +
        'lalu extract ke folder "realesrgan" di sebelah script ini.'
    );
    process.exit(1);
  }

  ensureDirs();
  const files = getVideoFiles();

  if (files.length === 0) {
    console.log(`Tidak ada video di ${INPUT_DIR}`);
    return;
  }

  console.log(
    `Ditemukan ${files.length} video. Mode: ${
      FORCE_SIZE ? `manual ${FORCED_WIDTH}x${FORCED_HEIGHT}` : 'otomatis (portrait/landscape)'
    } | Model: ${MODEL} x${AI_SCALE}\n`
  );

  const errors = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const counter = `[${i + 1}/${files.length}]`;

    if (SKIP_EXISTING && fs.existsSync(path.join(OUTPUT_DIR, file))) {
      console.log(`${counter} ${file} -> dilewati (sudah ada)`);
      continue;
    }

    try {
      await processVideo(file, counter);
    } catch (err) {
      console.error(`\n  Gagal: ${file} -> ${err.message}`);
      errors.push({ file, error: err.message });
    }
  }

  if (!KEEP_TEMP) rmDir(TEMP_DIR);

  console.log(`\nSelesai. Hasil ada di ${OUTPUT_DIR}`);
  if (errors.length > 0) {
    console.log('\nBeberapa file gagal:');
    errors.forEach((e) => console.log(`- ${e.file}: ${e.error}`));
  }
}

main();