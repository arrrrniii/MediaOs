const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const execFileAsync = promisify(execFile);

function tmpPath(ext = '') {
  return path.join(os.tmpdir(), `mv_${crypto.randomBytes(8).toString('hex')}${ext}`);
}

async function transcodeVideo(inputPath, options = {}) {
  const {
    crf = '20',
    maxHeight = 1080,
  } = options;

  const outputPath = tmpPath('.mp4');

  const vf = `scale=min(${maxHeight}\\,iw):min(${maxHeight}\\,ih):force_original_aspect_ratio=decrease:force_divisible_by=2`;

  await execFileAsync('ffmpeg', [
    '-i', inputPath,
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', String(crf),
    '-vf', vf,
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', '+faststart',
    '-pix_fmt', 'yuv420p',
    '-y',
    outputPath,
  ], { timeout: 600000 });

  const stat = await fs.promises.stat(outputPath);

  return {
    path: outputPath,
    size: stat.size,
  };
}

async function extractThumbnail(inputPath, outputPath = null) {
  const thumbPath = outputPath || tmpPath('.webp');

  // Try at 1s, fallback to 0s
  try {
    await execFileAsync('ffmpeg', [
      '-i', inputPath,
      '-ss', '1',
      '-vframes', '1',
      '-vf', 'scale=640:-2',
      '-c:v', 'libwebp',
      '-quality', '80',
      '-y',
      thumbPath,
    ], { timeout: 30000 });
  } catch {
    await execFileAsync('ffmpeg', [
      '-i', inputPath,
      '-ss', '0',
      '-vframes', '1',
      '-vf', 'scale=640:-2',
      '-c:v', 'libwebp',
      '-quality', '80',
      '-y',
      thumbPath,
    ], { timeout: 30000 });
  }

  return thumbPath;
}

async function getVideoDuration(inputPath) {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      inputPath,
    ], { timeout: 15000 });
    return parseFloat(stdout.trim()) || null;
  } catch {
    return null;
  }
}

async function gifToMp4(inputPath, options = {}) {
  const outputPath = tmpPath('.mp4');
  const { crf = '20' } = options;

  await execFileAsync('ffmpeg', [
    '-i', inputPath,
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-crf', String(crf),
    '-movflags', '+faststart',
    '-an',
    '-y',
    outputPath,
  ], { timeout: 120000 });

  const stat = await fs.promises.stat(outputPath);
  return { path: outputPath, size: stat.size };
}

function cleanup(...paths) {
  for (const p of paths) {
    fs.promises.unlink(p).catch(() => {});
  }
}

module.exports = { transcodeVideo, extractThumbnail, getVideoDuration, gifToMp4, cleanup, tmpPath };
