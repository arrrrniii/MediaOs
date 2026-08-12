/**
 * Subtitle helpers — accept WebVTT or SubRip (.srt) and normalize to WebVTT,
 * which is the only caption format browsers load through <track>.
 */

/**
 * Convert a SubRip (.srt) body to WebVTT: prepend the WEBVTT header, drop the
 * numeric cue counters, and switch the comma decimal separator in timestamps
 * to a dot (00:00:01,000 → 00:00:01.000). Idempotent-ish: a body that is
 * already WebVTT is returned effectively unchanged.
 */
function srtToVtt(input) {
  const text = String(input).replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  if (/^WEBVTT/.test(text)) return ensureVttHeader(text);

  const blocks = text.split(/\n\n+/);
  const out = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    // Drop a leading pure-numeric cue index (SubRip counter).
    if (lines.length && /^\d+$/.test(lines[0].trim())) lines.shift();
    if (lines.length === 0) continue;
    // Normalize the timing line's comma separators to dots.
    lines[0] = lines[0].replace(
      /(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2'
    );
    out.push(lines.join('\n'));
  }
  return `WEBVTT\n\n${out.join('\n\n')}\n`;
}

function ensureVttHeader(text) {
  return /^WEBVTT/.test(text) ? `${text}\n` : `WEBVTT\n\n${text}\n`;
}

/**
 * Normalize an uploaded subtitle buffer to a WebVTT string, given its declared
 * format ('srt' | 'vtt') or inferred from the filename extension.
 */
function toVtt(buffer, { format, filename } = {}) {
  const body = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer);
  const fmt = (format || (filename && filename.split('.').pop()) || '').toLowerCase();
  if (fmt === 'vtt') return ensureVttHeader(body.trim());
  if (fmt === 'srt') return srtToVtt(body);
  // Unknown extension: sniff. A WEBVTT header ⇒ vtt, else treat as srt.
  return /^\s*WEBVTT/.test(body) ? ensureVttHeader(body.trim()) : srtToVtt(body);
}

module.exports = { srtToVtt, toVtt, ensureVttHeader };
