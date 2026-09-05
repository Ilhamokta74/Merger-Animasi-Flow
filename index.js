/**
 * Video Merger
 * -------------
 * Struktur folder:
 *   input/
 *     Judul A/
 *       part1.mp4
 *       part2.mp4
 *     Judul B/
 *       clip1.mp4
 *       clip2.mp4
 *
 * Hasil merge akan disimpan di:
 *   output/Judul A.mp4
 *   output/Judul B.mp4
 *
 * Menampilkan progress bar + ETA per folder (judul) selama proses merge berjalan.
 *
 * Kebutuhan: ffmpeg harus sudah terinstall di sistem dan ada di PATH.
 * Cek dengan: ffmpeg -version
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const ffmpeg = require('fluent-ffmpeg');
const cliProgress = require('cli-progress');

// ================= KONFIGURASI =================
const INPUT_DIR = path.join(__dirname, 'input');
const OUTPUT_DIR = path.join(__dirname, 'output');
const TEMP_DIR = path.join(__dirname, '.temp');

const VIDEO_EXT = ['.mp4', '.mov', '.mkv', '.avi', '.ts', '.webm', '.m4v'];

// Mode penggabungan (HANYA dipakai kalau FADE.enabled = false):
//  - 'copy'    : cepat, tanpa re-encode. HANYA aman kalau semua potongan video
//                dalam satu folder punya codec/resolusi/format yang SAMA
//                (misal semua hasil rekaman dari sumber yang sama).
//  - 'reencode': lebih lambat tapi aman walau codec/resolusi berbeda-beda.
const MODE = 'copy';

// Fade in/out antar part. Kalau enabled = true, penggabungan SELALU re-encode
// (fade butuh proses ulang gambar & audio, tidak bisa stream-copy).
// Aturan otomatis per folder:
//  - part pertama : hanya fade-out di akhir
//  - part terakhir: hanya fade-in di awal
//  - part di tengah: fade-in di awal DAN fade-out di akhir
//  - kalau folder cuma 1 file: tidak ada fade sama sekali
const FADE = {
  enabled: true,
  duration: 1, // detik. Ini WAKTU TAMBAHAN di luar video asli (video asli tidak dipotong/diredupkan).
};
// =================================================

function naturalSort(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

function getVideoFiles(folderPath) {
  return fs
    .readdirSync(folderPath)
    .filter((f) => VIDEO_EXT.includes(path.extname(f).toLowerCase()))
    .sort(naturalSort)
    .map((f) => path.join(folderPath, f));
}

function getVideoInfo(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) return reject(err);
      const duration = data.format.duration || 0;
      const vStream = (data.streams || []).find((s) => s.codec_type === 'video');
      resolve({
        duration,
        width: (vStream && vStream.width) || 0,
        height: (vStream && vStream.height) || 0,
      });
    });
  });
}

// Pilih resolusi target = resolusi dengan area terbesar di antara semua file
// dalam folder, supaya kualitas video tidak turun karena upscale/downscale
// yang tidak perlu.
function pickTargetResolution(videoInfos) {
  let best = videoInfos[0];
  for (const v of videoInfos) {
    if (v.width * v.height > best.width * best.height) best = v;
  }
  return {
    width: best.width || 1280,
    height: best.height || 720,
  };
}

// Filter untuk menyamakan resolusi setiap video ke ukuran target:
// video di-scale supaya pas di dalam kotak target (tanpa distorsi), sisa
// ruang kosong diisi bar hitam (letterbox/pillarbox), lalu SAR diseragamkan.
function normalizeVideoFilter(targetW, targetH) {
  return (
    `scale=w=${targetW}:h=${targetH}:force_original_aspect_ratio=decrease,` +
    `pad=${targetW}:${targetH}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`
  );
}

// Filter untuk menyamakan audio (sample rate & channel layout) supaya
// concat tidak gagal kalau ada part yang audionya beda spek.
const NORMALIZE_AUDIO_FILTER = 'aformat=sample_rates=48000:channel_layouts=stereo';

function timeToSeconds(str) {
  // format: HH:MM:SS.ms
  const [h, m, s] = str.split(':');
  return parseInt(h, 10) * 3600 + parseInt(m, 10) * 60 + parseFloat(s);
}

function buildConcatList(files, listPath) {
  const content = files
    .map((f) => `file '${f.replace(/'/g, "'\\''")}'`)
    .join('\n');
  fs.writeFileSync(listPath, content);
}

function runFfmpeg(args, totalDuration, onProgress) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args);
    let stderrTail = '';

    proc.stderr.on('data', (chunk) => {
      const str = chunk.toString();
      stderrTail = (stderrTail + str).slice(-2000);
      const match = str.match(/time=(\d{2}:\d{2}:\d{2}\.\d{2})/);
      if (match) {
        const sec = timeToSeconds(match[1]);
        onProgress(Math.min(sec, totalDuration));
      }
    });

    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) {
        onProgress(totalDuration);
        resolve();
      } else {
        reject(new Error(`ffmpeg keluar dengan kode ${code}. Log terakhir:\n${stderrTail}`));
      }
    });
  });
}

async function mergeFolder(folderName, files, bar) {
  const videoInfos = await Promise.all(files.map(getVideoInfo));
  const durations = videoInfos.map((v) => v.duration);
  const baseDuration = durations.reduce((a, b) => a + b, 0) || 1;

  const outputPath = path.join(OUTPUT_DIR, `${folderName}.mp4`);
  const listPath = path.join(TEMP_DIR, `${folderName}.txt`);
  buildConcatList(files, listPath);

  if (FADE.enabled && files.length > 1) {
    bar.setTotal(Math.round(baseDuration)); // sementara, diupdate lagi begitu tahu durasi final
    bar.update(0, { status: 'memproses' });
    const onProgress = (sec) => bar.update(Math.round(sec));
    await fadeMerge(files, videoInfos, outputPath, bar, onProgress);
    bar.update(bar.getTotal(), { status: 'selesai' });
    return outputPath;
  }

  bar.setTotal(Math.round(baseDuration));
  bar.update(0, { status: 'memproses' });
  const onProgress = (sec) => bar.update(Math.round(sec));

  if (files.length === 1) {
    // cuma 1 file, tidak perlu digabung ataupun di-fade, cukup copy
    await runFfmpeg(['-y', '-i', files[0], '-c', 'copy', outputPath], baseDuration, onProgress);
  } else if (MODE === 'copy') {
    const args = ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', outputPath];
    try {
      await runFfmpeg(args, baseDuration, onProgress);
    } catch (err) {
      // fallback otomatis ke re-encode kalau stream copy gagal (codec/resolusi beda-beda)
      bar.update(0, { status: 'fallback re-encode' });
      await reencodeMerge(files, videoInfos, outputPath, baseDuration, onProgress);
    }
  } else {
    await reencodeMerge(files, videoInfos, outputPath, baseDuration, onProgress);
  }

  bar.update(Math.round(baseDuration), { status: 'selesai' });
  return outputPath;
}

async function reencodeMerge(files, videoInfos, outputPath, totalDuration, onProgress) {
  // pakai filter_complex concat: lebih toleran terhadap codec/resolusi berbeda.
  // Setiap video dinormalisasi dulu ke resolusi & format audio yang sama
  // supaya filter concat tidak gagal.
  const target = pickTargetResolution(videoInfos);
  const inputArgs = files.flatMap((f) => ['-i', f]);

  const filterParts = [];
  const pairLabels = [];
  files.forEach((_, i) => {
    filterParts.push(`[${i}:v]${normalizeVideoFilter(target.width, target.height)}[v${i}]`);
    filterParts.push(`[${i}:a]${NORMALIZE_AUDIO_FILTER}[a${i}]`);
    pairLabels.push(`[v${i}][a${i}]`);
  });

  const concatFilter = `${pairLabels.join('')}concat=n=${files.length}:v=1:a=1[outv][outa]`;
  const filterComplex = `${filterParts.join(';')};${concatFilter}`;

  const args = [
    '-y',
    ...inputArgs,
    '-filter_complex', filterComplex,
    '-map', '[outv]',
    '-map', '[outa]',
    '-c:v', 'libx264',
    '-c:a', 'aac',
    outputPath,
  ];
  await runFfmpeg(args, totalDuration, onProgress);
}

/**
 * Menggabungkan dengan fade TANPA meredupkan video asli:
 * video tiap part diputar penuh dulu, baru setelah itu ditambah waktu ekstra
 * (frame terakhir dibekukan) yang di-fade. Sebaliknya di awal part, frame
 * pertama dibekukan lalu di-fade-in SEBELUM konten asli mulai diputar.
 * Jadi durasi hasil akhir sedikit lebih panjang dari total durasi asli.
 */
async function fadeMerge(files, videoInfos, outputPath, bar, onProgress) {
  const n = files.length;
  const durations = videoInfos.map((v) => v.duration);
  const target = pickTargetResolution(videoInfos);
  const inputArgs = files.flatMap((f) => ['-i', f]);
  const fd = FADE.duration;

  const filterParts = [];
  const pairLabels = [];
  let totalExtended = 0;

  files.forEach((_, i) => {
    const dur = durations[i] || 0;
    const isFirst = i === 0;
    const isLast = i === n - 1;

    const startPad = isFirst ? 0 : fd;
    const endPad = isLast ? 0 : fd;
    const newDur = dur + startPad + endPad;
    totalExtended += newDur;

    // semua video dinormalisasi dulu ke resolusi & format audio yang sama
    // supaya concat tidak gagal walau part-nya beda resolusi/spek audio
    const vf = [normalizeVideoFilter(target.width, target.height)];
    const af = [NORMALIZE_AUDIO_FILTER];

    if (startPad > 0 || endPad > 0) {
      const tpadOpts = [];
      if (startPad > 0) tpadOpts.push(`start_mode=clone`, `start_duration=${startPad.toFixed(3)}`);
      if (endPad > 0) tpadOpts.push(`stop_mode=clone`, `stop_duration=${endPad.toFixed(3)}`);
      vf.push(`tpad=${tpadOpts.join(':')}`);
    }
    if (startPad > 0) {
      vf.push(`fade=t=in:st=0:d=${startPad.toFixed(3)}`);
      af.push(`adelay=${Math.round(startPad * 1000)}:all=1`);
      af.push(`afade=t=in:st=0:d=${startPad.toFixed(3)}`);
    }
    if (endPad > 0) {
      af.push(`apad=pad_dur=${endPad.toFixed(3)}`);
      const st = dur + startPad;
      vf.push(`fade=t=out:st=${st.toFixed(3)}:d=${endPad.toFixed(3)}`);
      af.push(`afade=t=out:st=${st.toFixed(3)}:d=${endPad.toFixed(3)}`);
    }

    const vChain = vf.join(',');
    const aChain = af.join(',');

    filterParts.push(`[${i}:v]${vChain}[v${i}]`);
    filterParts.push(`[${i}:a]${aChain}[a${i}]`);
    pairLabels.push(`[v${i}][a${i}]`);
  });

  bar.setTotal(Math.round(totalExtended));

  const concatFilter = `${pairLabels.join('')}concat=n=${n}:v=1:a=1[outv][outa]`;
  const filterComplex = `${filterParts.join(';')};${concatFilter}`;

  const args = [
    '-y',
    ...inputArgs,
    '-filter_complex', filterComplex,
    '-map', '[outv]',
    '-map', '[outa]',
    '-c:v', 'libx264',
    '-c:a', 'aac',
    outputPath,
  ];

  await runFfmpeg(args, totalExtended, onProgress);
}

async function main() {
  if (!fs.existsSync(INPUT_DIR)) {
    console.error(`Folder input tidak ditemukan: ${INPUT_DIR}`);
    process.exit(1);
  }

  const folders = fs
    .readdirSync(INPUT_DIR)
    .filter((f) => fs.statSync(path.join(INPUT_DIR, f)).isDirectory())
    .sort(naturalSort);

  if (folders.length === 0) {
    console.log('Tidak ada folder judul di dalam input/.');
    return;
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.mkdirSync(TEMP_DIR, { recursive: true });

  const tasks = folders
    .map((folderName) => ({
      folderName,
      files: getVideoFiles(path.join(INPUT_DIR, folderName)),
    }))
    .filter((t) => {
      if (t.files.length === 0) {
        console.log(`Folder "${t.folderName}" dilewati (tidak ada video).`);
        return false;
      }
      return true;
    });

  const errors = [];
  const total = tasks.length;

  // Diproses satu per satu (sequential), bukan sekaligus.
  // Progress bar untuk folder berikutnya baru muncul setelah folder
  // sebelumnya selesai.
  for (let i = 0; i < total; i++) {
    const task = tasks[i];
    console.log(`\n[${i + 1}/${total}] ${task.folderName}`);

    const bar = new cliProgress.SingleBar(
      {
        clearOnComplete: false,
        hideCursor: true,
        format: '  |{bar}| {percentage}% | {value}s/{total}s | ETA: {eta_formatted} | {status}',
      },
      cliProgress.Presets.shades_classic
    );
    bar.start(100, 0, { status: 'memproses' });

    try {
      await mergeFolder(task.folderName, task.files, bar);
    } catch (err) {
      bar.update(0, { status: 'GAGAL' });
      errors.push({ folder: task.folderName, error: err.message });
    } finally {
      bar.stop();
    }
  }

  fs.rmSync(TEMP_DIR, { recursive: true, force: true });

  console.log('\nSelesai. Hasil ada di folder output/.');
  if (errors.length > 0) {
    console.log('\nBeberapa folder gagal diproses:');
    errors.forEach((e) => console.log(`- ${e.folder}: ${e.error}`));
  }
}

main().catch((err) => {
  console.error('Terjadi error:', err);
  process.exit(1);
});