// NOTE: this file intentionally does NOT require ../setup, so it runs against
// the REAL sharp library and can assert on actual EXIF bytes in the output.
const sharp = require('sharp');
const { processImage } = require('../../src/services/imageProcessor');

async function makeJpegWithExif() {
  const base = await sharp({ create: { width: 16, height: 16, channels: 3, background: { r: 200, g: 10, b: 10 } } })
    .jpeg()
    .toBuffer();
  return sharp(base).withExif({ IFD0: { Copyright: 'mediaos-test' } }).jpeg().toBuffer();
}

describe('processImage metadata stripping', () => {
  it('strips EXIF from the optimized output by default', async () => {
    const input = await makeJpegWithExif();
    expect((await sharp(input).metadata()).exif).toBeDefined();

    const out = await processImage(input, { preserveMetadata: false });
    const meta = await sharp(out.buffer).metadata();
    expect(meta.exif).toBeUndefined();
    expect(out.mimeType).toBe('image/webp');
  });

  it('preserves metadata when the policy opts in', async () => {
    const input = await makeJpegWithExif();
    const out = await processImage(input, { preserveMetadata: true });
    const meta = await sharp(out.buffer).metadata();
    expect(meta.exif).toBeDefined();
  });
});
