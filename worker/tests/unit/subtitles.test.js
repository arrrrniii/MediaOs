const { srtToVtt, toVtt, ensureVttHeader } = require('../../src/utils/subtitles');

const SRT = `1
00:00:01,000 --> 00:00:04,000
Hello world

2
00:00:05,500 --> 00:00:08,250
Second line`;

describe('srtToVtt', () => {
  it('prepends the WEBVTT header', () => {
    expect(srtToVtt(SRT)).toMatch(/^WEBVTT\n\n/);
  });

  it('converts comma decimal separators to dots and drops cue indices', () => {
    const out = srtToVtt(SRT);
    expect(out).toContain('00:00:01.000 --> 00:00:04.000');
    expect(out).toContain('00:00:05.500 --> 00:00:08.250');
    // The numeric SubRip counters are gone.
    expect(out).not.toMatch(/^\s*1\s*$/m);
  });

  it('leaves an already-WEBVTT body intact', () => {
    const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi';
    expect(srtToVtt(vtt)).toMatch(/^WEBVTT/);
  });
});

describe('toVtt', () => {
  it('routes .srt through the converter', () => {
    expect(toVtt(Buffer.from(SRT), { format: 'srt' })).toContain('00:00:01.000');
  });

  it('passes .vtt through with a header ensured', () => {
    const out = toVtt(Buffer.from('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi'), { format: 'vtt' });
    expect(out).toMatch(/^WEBVTT/);
  });

  it('sniffs an unknown extension (SubRip → converted)', () => {
    expect(toVtt(Buffer.from(SRT), { filename: 'caption.txt' })).toMatch(/^WEBVTT/);
  });
});

describe('ensureVttHeader', () => {
  it('adds a header when missing', () => {
    expect(ensureVttHeader('00:00:01.000 --> 00:00:02.000\nHi')).toMatch(/^WEBVTT\n\n/);
  });
});
