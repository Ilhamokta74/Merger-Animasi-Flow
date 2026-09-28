/**
 * upscale-video.js
 *
 * Scans the ./input folder for video files, upscales each one to
 * 1080x1920 (Full HD vertical) with Lanczos scaling + sharpening to
 * avoid the blurry/distorted look, and saves the results to ./output.
 *
 * Folder structure (created automatically if missing):
 *   ./input/    <- put your .mp4 (or .mov/.mkv/.webm) files here
 *   ./output/   <- upscaled results appear here, same filenames
 *
 * Requirements:
 *   1. Node.js installed
 *   2. FFmpeg installed and available in PATH
 *      - Windows: https://www.gyan.dev/ffmpeg/builds/ (add to PATH)
 *      - macOS:   brew install ffmpeg
 *      - Linux:   sudo apt install ffmpeg
 *
 * Install dependency:
 *   npm install fluent-ffmpeg
 *
 * Run:
 *   node upscale-video.js
 *
 * Optional: override target size
 *   node upscale-video.js 1080 1920
 */

const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');

// ---- CONFIG -----------------------------------------------------------
const INPUT_DIR = path.resolve(__dirname, 'output');
const OUTPUT_DIR = path.resolve(__dirname, 'output_1080');
const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.mkv', '.webm', '.avi'];

const [, , widthArg, heightArg] = process.argv;
const TARGET_WIDTH = parseInt(widthArg, 10) || 1080;
const TARGET_HEIGHT = parseInt(heightArg, 10) || 1920;

// SHARPEN_AMOUNT: 0.6-1.2 = safe/natural. Above 2 causes halo artifacts.
const SHARPEN_AMOUNT = 0.8;

// ---- SETUP --------------------------------------------------------------
function ensureDirs() {
  for (const dir of [INPUT_DIR, OUTPUT_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}

function getVideoFiles() {
  return fs
    .readdirSync(INPUT_DIR)
    .filter((f) => VIDEO_EXTENSIONS.includes(path.extname(f).toLowerCase()));
}

/**
 * Filter chain:
 * 1. scale   -> Lanczos (best quality upscale, avoids the blur/soft look
 *               that bilinear/bicubic scaling produces)
 * 2. pad     -> keeps aspect ratio intact instead of stretching (stretching
 *               is what causes visible distortion) if source AR != target AR
 * 3. unsharp -> re-adds edge definition lost during upscaling
 */
function buildFilterChain(width, height) {
  return [
    `scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos`,
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`,
    `unsharp=5:5:${SHARPEN_AMOUNT}:5:5:0.0`,
  ].join(',');
}

function upscaleVideo(inputPath, outputPath, width, height) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .videoFilters(buildFilterChain(width, height))
      .videoCodec('libx264')
      .outputOptions([
        '-preset slow', // better compression efficiency = better quality at same bitrate
        '-crf 18',      // visually near-lossless (lower = higher quality)
        '-pix_fmt yuv420p',
        '-movflags +faststart',
      ])
      .audioCodec('aac')
      .audioBitrate('192k')
      .on('start', (cmd) => console.log('  FFmpeg command:', cmd))
      .on('progress', (p) => {
        if (p.percent) process.stdout.write(`\r  Progress: ${p.percent.toFixed(1)}%`);
      })
      .on('error', (err) => reject(err))
      .on('end', () => {
        console.log('\n  Done ->', outputPath);
        resolve(outputPath);
      })
      .save(outputPath);
  });
}

async function main() {
  ensureDirs();
  const files = getVideoFiles();

  if (files.length === 0) {
    console.log(`No video files found in ${INPUT_DIR}`);
    console.log('Put your .mp4/.mov/.mkv/.webm files there and run again.');
    return;
  }

  console.log(`Found ${files.length} video(s). Target: ${TARGET_WIDTH}x${TARGET_HEIGHT}\n`);

  for (const file of files) {
    const inputPath = path.join(INPUT_DIR, file);
    const outputPath = path.join(OUTPUT_DIR, file);
    console.log(`Processing: ${file}`);
    try {
      await upscaleVideo(inputPath, outputPath, TARGET_WIDTH, TARGET_HEIGHT);
    } catch (err) {
      console.error(`  Failed: ${file} ->`, err.message);
    }
  }

  console.log('\nAll done. Check the output/ folder.');
}

main();
