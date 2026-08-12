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

/**
 * Probe a video for the facts the HLS pipeline needs: duration, source pixel
 * dimensions, and whether it carries an audio stream (so we know whether to
 * emit an AAC track / mp4a codec tag). Returns nulls on failure rather than
 * throwing, so the caller decides how to degrade.
 */
async function probeVideo(inputPath) {
  const out = { duration: null, width: null, height: null, hasAudio: false };
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration:stream=codec_type,width,height',
      '-of', 'json',
      inputPath,
    ], { timeout: 20000 });
    const data = JSON.parse(stdout);
    if (data.format && data.format.duration) out.duration = parseFloat(data.format.duration) || null;
    for (const s of data.streams || []) {
      if (s.codec_type === 'video' && out.width == null) {
        out.width = s.width || null;
        out.height = s.height || null;
      }
      if (s.codec_type === 'audio') out.hasAudio = true;
    }
  } catch {
    // best-effort; caller falls back to getVideoDuration / defaults
  }
  return out;
}

// The adaptive-bitrate ladder. Each rung is only produced when the SOURCE is at
// least that tall (never upscale). Bitrates are conservative H.264 targets;
// BANDWIDTH advertised in the master playlist uses the video maxrate + audio
// bitrate as a peak estimate.
const HLS_LADDER = [
  { height: 360, vbitrate: 800000, maxrate: 856000, bufsize: 1200000, abitrate: 96000 },
  { height: 480, vbitrate: 1400000, maxrate: 1498000, bufsize: 2100000, abitrate: 128000 },
  { height: 720, vbitrate: 2800000, maxrate: 2996000, bufsize: 4200000, abitrate: 128000 },
  { height: 1080, vbitrate: 5000000, maxrate: 5350000, bufsize: 7500000, abitrate: 192000 },
];

const HLS_SEGMENT_SECONDS = parseInt(process.env.HLS_SEGMENT_SECONDS || '6', 10);

function evenDown(n) {
  const v = Math.floor(n);
  return v % 2 === 0 ? v : v - 1;
}

/**
 * Choose the ladder rungs to produce for a source of the given height, never
 * upscaling. When the source is shorter than the smallest rung, a single
 * rendition clamped to the source height is produced so playback still works.
 */
function selectRenditions(sourceHeight, ladder = HLS_LADDER) {
  const h = Number.isFinite(sourceHeight) && sourceHeight > 0 ? sourceHeight : 1080;
  const chosen = ladder.filter((r) => r.height <= h);
  if (chosen.length > 0) return chosen.map((r) => ({ ...r }));
  // Source is smaller than the smallest rung — emit one rendition at the
  // source height using the lowest rung's bitrate profile.
  const base = ladder[0];
  return [{ ...base, height: evenDown(h) || base.height }];
}

/**
 * Produce an HLS adaptive-bitrate package for `inputPath` under `outDir`:
 *   outDir/master.m3u8
 *   outDir/<h>p/index.m3u8 + seg_XXX.ts   (one per rendition)
 *   outDir/poster.jpg
 *
 * One ffmpeg invocation per rendition keeps the pipeline easy to reason about
 * and to make idempotent; the master playlist is written by hand referencing
 * each media playlist with BANDWIDTH/RESOLUTION/CODECS. Renditions never
 * exceed the source height. Returns the file layout + probed metadata.
 *
 * @param {string} inputPath
 * @param {string} outDir       must already exist (caller owns the temp dir)
 * @param {object} [opts]
 * @param {object} [opts.probe] a prior probeVideo() result (avoids re-probing)
 * @param {Array}  [opts.ladder]
 */
async function transcodeHls(inputPath, outDir, opts = {}) {
  const probe = opts.probe || await probeVideo(inputPath);
  const sourceHeight = probe.height || 1080;
  const sourceWidth = probe.width || Math.round((sourceHeight * 16) / 9);
  const hasAudio = probe.hasAudio !== false;
  const ladder = opts.ladder || HLS_LADDER;
  const rungs = selectRenditions(sourceHeight, ladder);

  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
  const renditions = [];
  let done = 0;
  for (const rung of rungs) {
    const h = evenDown(Math.min(rung.height, sourceHeight)) || rung.height;
    const w = evenDown((sourceWidth * h) / sourceHeight) || evenDown(sourceWidth);
    const dir = path.join(outDir, `${h}p`);
    await fs.promises.mkdir(dir, { recursive: true });
    const playlistName = 'index.m3u8';
    const playlistPath = path.join(dir, playlistName);

    const args = [
      '-i', inputPath,
      '-vf', `scale=-2:${h}`,
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-profile:v', 'main',
      '-b:v', String(rung.vbitrate),
      '-maxrate', String(rung.maxrate),
      '-bufsize', String(rung.bufsize),
      '-pix_fmt', 'yuv420p',
      // Force keyframes on segment boundaries so every segment starts clean.
      '-force_key_frames', `expr:gte(t,n_forced*${HLS_SEGMENT_SECONDS})`,
    ];
    if (hasAudio) {
      args.push('-c:a', 'aac', '-b:a', String(rung.abitrate), '-ac', '2');
    } else {
      args.push('-an');
    }
    args.push(
      '-hls_time', String(HLS_SEGMENT_SECONDS),
      '-hls_playlist_type', 'vod',
      '-hls_segment_filename', path.join(dir, 'seg_%03d.ts'),
      '-f', 'hls',
      '-y',
      playlistPath,
    );

    await execFileAsync('ffmpeg', args, { timeout: opts.timeout || 1800000 });

    const files = (await fs.promises.readdir(dir)).sort();
    const segmentFiles = files.filter((f) => f.endsWith('.ts'));
    let bytes = 0;
    for (const f of files) {
      try { bytes += (await fs.promises.stat(path.join(dir, f))).size; } catch { /* noop */ }
    }

    const codecs = hasAudio ? 'avc1.4d401f,mp4a.40.2' : 'avc1.4d401f';
    renditions.push({
      height: h,
      width: w,
      vbitrate: rung.vbitrate,
      abitrate: hasAudio ? rung.abitrate : 0,
      bandwidth: rung.maxrate + (hasAudio ? rung.abitrate : 0),
      codecs,
      dir,
      playlistName,
      playlistPath,
      segmentFiles,
      bytes,
    });
    done++;
    if (onProgress) { try { onProgress(done / rungs.length); } catch { /* best effort */ } }
  }

  // Master playlist referencing each rendition's media playlist.
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3'];
  for (const r of renditions) {
    lines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${r.bandwidth},RESOLUTION=${r.width}x${r.height},CODECS="${r.codecs}"`
    );
    lines.push(`${r.height}p/${r.playlistName}`);
  }
  const masterPath = path.join(outDir, 'master.m3u8');
  await fs.promises.writeFile(masterPath, lines.join('\n') + '\n', 'utf8');

  // Poster frame (~1s, fallback to 0s) as a JPEG.
  const posterPath = path.join(outDir, 'poster.jpg');
  const posterVf = `scale='min(1280,iw)':-2`;
  try {
    await execFileAsync('ffmpeg', [
      '-ss', '1', '-i', inputPath, '-vframes', '1', '-vf', posterVf, '-q:v', '3', '-y', posterPath,
    ], { timeout: 30000 });
  } catch {
    await execFileAsync('ffmpeg', [
      '-ss', '0', '-i', inputPath, '-vframes', '1', '-vf', posterVf, '-q:v', '3', '-y', posterPath,
    ], { timeout: 30000 });
  }

  return {
    masterPath,
    posterPath,
    renditions,
    duration: probe.duration,
    width: sourceWidth,
    height: sourceHeight,
    hasAudio,
  };
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

module.exports = {
  transcodeVideo, extractThumbnail, getVideoDuration, gifToMp4, cleanup, tmpPath,
  probeVideo, transcodeHls, selectRenditions, HLS_LADDER, HLS_SEGMENT_SECONDS,
};
