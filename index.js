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

// Berapa folder yang boleh diproses bersamaan (paralel).
// 1 = satu-satu (paling aman & stabil untuk CPU/disk).
const CONCURRENCY = 1;

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
  duration: 0.5, // detik, otomatis dikecilkan kalau part-nya lebih pendek dari 2x durasi ini
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

function getDuration(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) return reject(err);
      resolve(data.format.duration || 0);
    });
  });
}

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
  const durations = await Promise.all(files.map(getDuration));
  const totalDuration = durations.reduce((a, b) => a + b, 0) || 1;
  bar.setTotal(Math.round(totalDuration));
  bar.update(0, { status: 'memproses' });

  const outputPath = path.join(OUTPUT_DIR, `${folderName}.mp4`);
  const listPath = path.join(TEMP_DIR, `${folderName}.txt`);
  buildConcatList(files, listPath);

  const onProgress = (sec) => bar.update(Math.round(sec));

  if (FADE.enabled && files.length > 1) {
    await fadeMerge(files, durations, outputPath, totalDuration, onProgress);
  } else if (files.length === 1) {
    // cuma 1 file, tidak perlu digabung ataupun di-fade, cukup copy
    await runFfmpeg(['-y', '-i', files[0], '-c', 'copy', outputPath], totalDuration, onProgress);
  } else if (MODE === 'copy') {
    const args = ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', outputPath];
    try {
      await runFfmpeg(args, totalDuration, onProgress);
    } catch (err) {
      // fallback otomatis ke re-encode kalau stream copy gagal (codec beda-beda)
      bar.update(0, { status: 'fallback re-encode' });
      await reencodeMerge(files, outputPath, totalDuration, onProgress);
    }
  } else {
    await reencodeMerge(files, outputPath, totalDuration, onProgress);
  }

  bar.update(Math.round(totalDuration), { status: 'selesai' });
  return outputPath;
}

async function reencodeMerge(files, outputPath, totalDuration, onProgress) {
  // pakai filter_complex concat: lebih toleran terhadap codec/resolusi berbeda
  const inputArgs = files.flatMap((f) => ['-i', f]);
  const streams = files.map((_, i) => `[${i}:v:0][${i}:a:0]`).join('');
  const filter = `${streams}concat=n=${files.length}:v=1:a=1[outv][outa]`;
  const args = [
    '-y',
    ...inputArgs,
    '-filter_complex', filter,
    '-map', '[outv]',
    '-map', '[outa]',
    '-c:v', 'libx264',
    '-c:a', 'aac',
    outputPath,
  ];
  await runFfmpeg(args, totalDuration, onProgress);
}

async function fadeMerge(files, durations, outputPath, totalDuration, onProgress) {
  const n = files.length;
  const inputArgs = files.flatMap((f) => ['-i', f]);

  const filterParts = [];
  const pairLabels = [];

  files.forEach((_, i) => {
    const dur = durations[i] || 0;
    const isFirst = i === 0;
    const isLast = i === n - 1;

    // fade tidak boleh lebih panjang dari setengah durasi clip-nya,
    // biar fade-in dan fade-out (kalau ada keduanya) tidak saling tabrakan
    const fd = Math.max(0.05, Math.min(FADE.duration, dur / 2 - 0.05));

    const vf = [];
    const af = [];

    if (!isFirst) {
      vf.push(`fade=t=in:st=0:d=${fd.toFixed(3)}`);
      af.push(`afade=t=in:st=0:d=${fd.toFixed(3)}`);
    }
    if (!isLast) {
      const st = Math.max(0, dur - fd);
      vf.push(`fade=t=out:st=${st.toFixed(3)}:d=${fd.toFixed(3)}`);
      af.push(`afade=t=out:st=${st.toFixed(3)}:d=${fd.toFixed(3)}`);
    }

    const vChain = vf.length ? vf.join(',') : 'null';
    const aChain = af.length ? af.join(',') : 'anull';

    filterParts.push(`[${i}:v]${vChain}[v${i}]`);
    filterParts.push(`[${i}:a]${aChain}[a${i}]`);
    pairLabels.push(`[v${i}][a${i}]`);
  });

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

  await runFfmpeg(args, totalDuration, onProgress);
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

  const multibar = new cliProgress.MultiBar(
    {
      clearOnComplete: false,
      hideCursor: true,
      format: '{folder} |{bar}| {percentage}% | {value}s/{total}s | ETA: {eta_formatted} | {status}',
    },
    cliProgress.Presets.shades_classic
  );

  const tasks = folders
    .map((folderName) => {
      const folderPath = path.join(INPUT_DIR, folderName);
      const files = getVideoFiles(folderPath);
      const bar = multibar.create(100, 0, {
        folder: folderName.padEnd(20).slice(0, 20),
        status: 'menunggu',
      });
      return { folderName, files, bar };
    })
    .filter((t) => {
      if (t.files.length === 0) {
        t.bar.update(0, { status: 'dilewati (kosong)' });
        t.bar.stop();
        return false;
      }
      return true;
    });

  const errors = [];
  let idx = 0;

  async function worker() {
    while (idx < tasks.length) {
      const task = tasks[idx++];
      try {
        await mergeFolder(task.folderName, task.files, task.bar);
      } catch (err) {
        task.bar.update(0, { status: 'GAGAL' });
        errors.push({ folder: task.folderName, error: err.message });
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  multibar.stop();

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
