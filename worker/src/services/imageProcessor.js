const sharp = require('sharp');

// Second line of defense against decompression bombs; fileService rejects
// oversized images up front, this stops libvips from decoding one anyway.
const MAX_IMAGE_PIXELS = parseInt(process.env.MAX_IMAGE_PIXELS || '50000000', 10);
const SHARP_INPUT_OPTIONS = { limitInputPixels: MAX_IMAGE_PIXELS };
const MAX_EXPOSURE_PIXELS = Math.min(MAX_IMAGE_PIXELS, 12_000_000);
const EXPOSURE_INPUT_OPTIONS = { limitInputPixels: MAX_EXPOSURE_PIXELS };
const EXPOSURE_SAMPLE_SIZE = 192;
const EXPOSURE_GAMMA = 1.18;

async function isAnimatedGif(buffer) {
  try {
    const metadata = await sharp(buffer, SHARP_INPUT_OPTIONS).metadata();
    return metadata.format === 'gif' && metadata.pages && metadata.pages > 1;
  } catch {
    return false;
  }
}

function percentile(histogram, count, fraction) {
  const rank = Math.ceil(count * fraction);
  let seen = 0;
  for (let level = 0; level < histogram.length; level++) {
    seen += histogram[level];
    if (seen >= rank) return level;
  }
  return 255;
}

async function needsAutoExposure(buffer, metadata) {
  if (!metadata || metadata.hasAlpha || (metadata.pages ?? 1) > 1) return false;
  const { width, height } = metadata;
  if (!width || !height || width < 128 || height < 128 || width * height > MAX_EXPOSURE_PIXELS) return false;

  try {
    const { data, info } = await sharp(buffer, EXPOSURE_INPUT_OPTIONS)
      .rotate()
      .resize(EXPOSURE_SAMPLE_SIZE, EXPOSURE_SAMPLE_SIZE, { fit: 'inside', withoutEnlargement: true })
      .toColourspace('srgb')
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (info.channels !== 3) return false;

    const histogram = new Uint32Array(256);
    for (let i = 0; i < data.length; i += 3) {
      const luma = Math.round(0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]);
      histogram[luma]++;
    }

    const count = info.width * info.height;
    const shadows = percentile(histogram, count, 0.10);
    const midtones = percentile(histogram, count, 0.50);
    const upperTones = percentile(histogram, count, 0.90);
    const highlights = percentile(histogram, count, 0.99);

    // Lift clearly dark photos with usable tonal detail. Skip images with
    // deep shadows, a narrow tonal range, or already bright highlights.
    return shadows >= 12 && midtones <= 72 && upperTones <= 155 &&
      upperTones - shadows >= 28 && highlights <= 215;
  } catch {
    return false;
  }
}

async function processImage(buffer, options = {}) {
  const {
    maxWidth = 1600,
    maxHeight = 1600,
    quality = 80,
    preserveMetadata = false,
    autoExposure = false,
  } = options;

  const start = Date.now();

  function encode(adjustExposure) {
    // Bake in EXIF orientation before dropping metadata from the WebP.
    const pipeline = sharp(buffer, adjustExposure ? EXPOSURE_INPUT_OPTIONS : SHARP_INPUT_OPTIONS)
      .rotate()
      .resize(maxWidth, maxHeight, { fit: 'inside', withoutEnlargement: true });
    // The output gamma lifts midtones while preserving black and white.
    if (adjustExposure) pipeline.gamma(1, EXPOSURE_GAMMA);
    if (preserveMetadata) pipeline.withMetadata();
    return pipeline.webp({ quality }).toBuffer({ resolveWithObject: true });
  }

  let exposureAdjusted = autoExposure;
  let result;
  try {
    result = await encode(autoExposure);
  } catch (error) {
    if (!autoExposure) throw error;
    result = await encode(false);
    exposureAdjusted = false;
  }

  return {
    buffer: result.data,
    width: result.info.width,
    height: result.info.height,
    size: result.data.length,
    mimeType: 'image/webp',
    ext: '.webp',
    processingMs: Date.now() - start,
    exposureAdjusted,
  };
}

module.exports = { processImage, isAnimatedGif, needsAutoExposure };
