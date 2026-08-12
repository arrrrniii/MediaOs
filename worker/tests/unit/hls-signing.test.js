const {
  rewriteHlsPlaylist, signStorageKey, validateOriginal,
} = require('../../src/services/signedUrl');

const SECRET = 'a'.repeat(64);

const MASTER = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-STREAM-INF:BANDWIDTH=952000,RESOLUTION=640x360,CODECS="avc1.4d401f,mp4a.40.2"',
  '360p/index.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=3124000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"',
  '720p/index.m3u8',
  '',
].join('\n');

const MEDIA = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-TARGETDURATION:6',
  '#EXTINF:6.000,',
  'seg_000.ts',
  '#EXTINF:4.000,',
  'seg_001.ts',
  '#EXT-X-ENDLIST',
  '',
].join('\n');

const DIR = 'proj-1/clip-abc/hls';        // master lives here
const MEDIA_DIR = 'proj-1/clip-abc/hls/720p';

describe('rewriteHlsPlaylist — signed child URIs', () => {
  it('appends token+expires to each child playlist URI, signed over its own key', () => {
    const expires = Math.floor(Date.now() / 1000) + 3600;
    const out = rewriteHlsPlaylist(MASTER, DIR, SECRET, expires);

    // Both child playlists carry a token + the SAME expiry.
    const lines = out.split('\n').filter((l) => l.includes('index.m3u8'));
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).toMatch(/\?token=[a-f0-9]+&expires=\d+$/);
      expect(line).toContain(`expires=${expires}`);
    }

    // The 720p child's token validates against its full storage key.
    const child720 = lines.find((l) => l.startsWith('720p/'));
    const token = child720.match(/token=([a-f0-9]+)/)[1];
    expect(validateOriginal(SECRET, `${DIR}/720p/index.m3u8`, token, expires)).toBe(true);
    // …and NOT against a different key (no cross-key replay).
    expect(validateOriginal(SECRET, `${DIR}/360p/index.m3u8`, token, expires)).toBe(false);
  });

  it('signs segment URIs in a media playlist against their own keys', () => {
    const expires = Math.floor(Date.now() / 1000) + 3600;
    const out = rewriteHlsPlaylist(MEDIA, MEDIA_DIR, SECRET, expires);
    const seg = out.split('\n').find((l) => l.startsWith('seg_000.ts'));
    const token = seg.match(/token=([a-f0-9]+)/)[1];
    expect(validateOriginal(SECRET, `${MEDIA_DIR}/seg_000.ts`, token, expires)).toBe(true);
  });

  it('leaves comment/tag lines untouched', () => {
    const out = rewriteHlsPlaylist(MASTER, DIR, SECRET, 12345);
    expect(out).toContain('#EXT-X-STREAM-INF:BANDWIDTH=952000,RESOLUTION=640x360,CODECS="avc1.4d401f,mp4a.40.2"');
  });

  it('a rewritten token stops validating after it expires', () => {
    const expired = Math.floor(Date.now() / 1000) - 60;
    const token = signStorageKey(SECRET, `${DIR}/360p/index.m3u8`, expired);
    expect(validateOriginal(SECRET, `${DIR}/360p/index.m3u8`, token, expired)).toBe(false);
  });
});
