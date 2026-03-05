const { getMimeType } = require('../../src/utils/mimeTypes');

describe('getMimeType', () => {
  it('should return correct MIME types for images', () => {
    expect(getMimeType('.jpg')).toBe('image/jpeg');
    expect(getMimeType('.png')).toBe('image/png');
    expect(getMimeType('.gif')).toBe('image/gif');
    expect(getMimeType('.webp')).toBe('image/webp');
    expect(getMimeType('.svg')).toBe('image/svg+xml');
  });

  it('should return correct MIME types for video', () => {
    expect(getMimeType('.mp4')).toBe('video/mp4');
    expect(getMimeType('.mov')).toBe('video/quicktime');
    expect(getMimeType('.webm')).toBe('video/webm');
  });

  it('should return correct MIME types for audio', () => {
    expect(getMimeType('.mp3')).toBe('audio/mpeg');
    expect(getMimeType('.wav')).toBe('audio/wav');
    expect(getMimeType('.flac')).toBe('audio/flac');
  });

  it('should return correct MIME types for documents', () => {
    expect(getMimeType('.pdf')).toBe('application/pdf');
    expect(getMimeType('.json')).toBe('application/json');
    expect(getMimeType('.csv')).toBe('text/csv');
  });

  it('should return octet-stream for unknown types', () => {
    expect(getMimeType('.xyz')).toBe('application/octet-stream');
    expect(getMimeType('.abc')).toBe('application/octet-stream');
  });

  it('should be case-insensitive', () => {
    expect(getMimeType('.JPG')).toBe('image/jpeg');
    expect(getMimeType('.PDF')).toBe('application/pdf');
  });
});
