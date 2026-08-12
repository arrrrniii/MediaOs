const sharp = require('sharp');

// Second line of defense against decompression bombs; fileService rejects
// oversized images up front, this stops libvips from decoding one anyway.
const MAX_IMAGE_PIXELS = parseInt(process.env.MAX_IMAGE_PIXELS || '50000000', 10);
const SHARP_INPUT_OPTIONS = { limitInputPixels: MAX_IMAGE_PIXELS };

async function isAnimatedGif(buffer) {
  try {
    const metadata = await sharp(buffer, SHARP_INPUT_OPTIONS).metadata();
    return metadata.format === 'gif' && metadata.pages && metadata.pages > 1;
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
  } = options;

  const start = Date.now();

  // .rotate() with no argument bakes the EXIF orientation into the pixels, so
  // stripping metadata below can't leave the image sideways. Sharp drops all
  // other metadata (EXIF/GPS/etc.) by default; we only re-attach it when the
  // project's original-preservation policy asks to preserve metadata on the
  // OPTIMIZED output. The preserved SOURCE object always keeps its metadata.
  let pipeline = sharp(buffer, SHARP_INPUT_OPTIONS)
    .rotate()
    .resize(maxWidth, maxHeight, {
      fit: 'inside',
      withoutEnlargement: true,
    });
  if (preserveMetadata) {
    pipeline = pipeline.withMetadata();
  }
  const result = await pipeline
    .webp({ quality })
    .toBuffer({ resolveWithObject: true });

  const metadata = await sharp(result.data, SHARP_INPUT_OPTIONS).metadata();

  return {
    buffer: result.data,
    width: metadata.width,
    height: metadata.height,
    size: result.data.length,
    mimeType: 'image/webp',
    ext: '.webp',
    processingMs: Date.now() - start,
  };
}

module.exports = { processImage, isAnimatedGif };
