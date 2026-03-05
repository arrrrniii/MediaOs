const { getFileType } = require('../../src/utils/fileTypes');

describe('getFileType', () => {
  it('should identify image types', () => {
    expect(getFileType('.jpg')).toBe('image');
    expect(getFileType('.jpeg')).toBe('image');
    expect(getFileType('.png')).toBe('image');
    expect(getFileType('.gif')).toBe('image');
    expect(getFileType('.webp')).toBe('image');
    expect(getFileType('.heic')).toBe('image');
    expect(getFileType('.avif')).toBe('image');
    expect(getFileType('.bmp')).toBe('image');
  });

  it('should identify video types', () => {
    expect(getFileType('.mov')).toBe('video');
    expect(getFileType('.avi')).toBe('video');
    expect(getFileType('.mkv')).toBe('video');
    expect(getFileType('.webm')).toBe('video');
  });

  it('should identify MP4 as video_passthrough', () => {
    expect(getFileType('.mp4')).toBe('video_passthrough');
  });

  it('should identify audio types', () => {
    expect(getFileType('.mp3')).toBe('audio');
    expect(getFileType('.wav')).toBe('audio');
    expect(getFileType('.flac')).toBe('audio');
    expect(getFileType('.ogg')).toBe('audio');
  });

  it('should return file for unknown types', () => {
    expect(getFileType('.pdf')).toBe('file');
    expect(getFileType('.zip')).toBe('file');
    expect(getFileType('.docx')).toBe('file');
    expect(getFileType('.xyz')).toBe('file');
  });

  it('should be case-insensitive', () => {
    expect(getFileType('.JPG')).toBe('image');
    expect(getFileType('.MP4')).toBe('video_passthrough');
    expect(getFileType('.MOV')).toBe('video');
  });
});
