const sharp = require('sharp');

async function isAnimatedGif(buffer) {
  try {
    const metadata = await sharp(buffer).metadata();
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

  const result = await sharp(buffer)
    .resize(maxWidth, maxHeight, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    .webp({ quality })
    .toBuffer({ resolveWithObject: true });

  const metadata = await sharp(result.data).metadata();

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
