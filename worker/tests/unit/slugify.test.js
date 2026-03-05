const { slugify } = require('../../src/utils/slugify');

describe('slugify', () => {
  it('should lowercase and replace spaces with hyphens', () => {
    expect(slugify('My Photo.jpg')).toBe('my-photo');
  });

  it('should remove file extension', () => {
    expect(slugify('image.png')).toBe('image');
  });

  it('should remove special characters', () => {
    expect(slugify('hello@world#2024!.jpg')).toBe('hello-world-2024');
  });

  it('should handle unicode/diacritics', () => {
    expect(slugify('café.png')).toBe('cafe');
  });

  it('should trim leading/trailing hyphens', () => {
    expect(slugify('--test--.jpg')).toBe('test');
  });

  it('should truncate to 100 chars', () => {
    const longName = 'a'.repeat(200) + '.jpg';
    expect(slugify(longName).length).toBeLessThanOrEqual(100);
  });

  it('should fallback to "file" for empty result', () => {
    expect(slugify('....jpg')).toBe('file');
  });

  it('should handle multiple dots', () => {
    expect(slugify('my.file.name.jpg')).toBe('my-file-name');
  });
});
