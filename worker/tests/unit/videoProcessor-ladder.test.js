// The ladder-selection logic is pure (no ffmpeg), so test it against the real
// module rather than the global mock.
const actual = jest.requireActual('../../src/services/videoProcessor');

describe('selectRenditions — never upscales', () => {
  it('a 480p source yields only 360p and 480p', () => {
    const heights = actual.selectRenditions(480).map((r) => r.height);
    expect(heights).toEqual([360, 480]);
  });

  it('a 720p source yields 360/480/720 but never 1080', () => {
    const heights = actual.selectRenditions(720).map((r) => r.height);
    expect(heights).toEqual([360, 480, 720]);
  });

  it('a 1080p source yields the full ladder', () => {
    const heights = actual.selectRenditions(1080).map((r) => r.height);
    expect(heights).toEqual([360, 480, 720, 1080]);
  });

  it('a source shorter than the smallest rung yields a single clamped rendition', () => {
    const chosen = actual.selectRenditions(240);
    expect(chosen).toHaveLength(1);
    expect(chosen[0].height).toBe(240);
  });

  it('an unknown source height defaults to the full ladder', () => {
    const heights = actual.selectRenditions(null).map((r) => r.height);
    expect(heights).toEqual([360, 480, 720, 1080]);
  });
});
