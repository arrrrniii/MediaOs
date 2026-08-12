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
  } = options;

  const start = Date.now();

  const result = await sharp(buffer, SHARP_INPUT_OPTIONS)
    .resize(maxWidth, maxHeight, {
      fit: 'inside',
      withoutEnlargement: true,
    })
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
