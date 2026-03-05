const IMAGE_EXTS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.tiff', '.tif',
  '.heic', '.heif', '.avif', '.webp',
]);

const VIDEO_EXTS = new Set([
  '.mov', '.avi', '.mkv', '.wmv', '.flv', '.webm', '.m4v', '.3gp',
]);

const VIDEO_PASSTHROUGH_EXTS = new Set(['.mp4']);

const AUDIO_EXTS = new Set([
  '.mp3', '.wav', '.flac', '.aac', '.ogg', '.m4a', '.wma',
]);

function getFileType(ext) {
  const lower = ext.toLowerCase();
  if (IMAGE_EXTS.has(lower)) return 'image';
  if (VIDEO_EXTS.has(lower)) return 'video';
  if (VIDEO_PASSTHROUGH_EXTS.has(lower)) return 'video_passthrough';
  if (AUDIO_EXTS.has(lower)) return 'audio';
  return 'file';
}

module.exports = { getFileType, IMAGE_EXTS, VIDEO_EXTS, VIDEO_PASSTHROUGH_EXTS, AUDIO_EXTS };
