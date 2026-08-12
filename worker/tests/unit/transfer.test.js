const fs = require('fs');
const { Readable } = require('stream');
const crypto = require('crypto');
const { copyVerified, ChecksumMismatchError } = require('../../src/storage/transfer');

const streamOf = (buf) => Readable.from([buf]);
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function sourceClient(buf) {
  return {
    getObject: jest.fn(async () => streamOf(buf)),
    statObject: jest.fn(async () => ({ size: buf.length })),
  };
}

// An in-memory destination backend. `corrupt` forces the read-back to differ
// from what was written, simulating a silent corruption on the cold side.
function destClient({ corrupt = false, sizeLie = null } = {}) {
  const store = {};
  return {
    _store: store,
    putFile: jest.fn(async (key, path) => { store[key] = fs.readFileSync(path); }),
    statObject: jest.fn(async (key) => ({ size: sizeLie != null ? sizeLie : store[key].length })),
    getObject: jest.fn(async (key) => streamOf(corrupt ? Buffer.from('different-bytes-xx') : store[key])),
  };
}

describe('copyVerified', () => {
  it('copies bytes and returns the verified checksum', async () => {
    const body = Buffer.from('hello cold storage world');
    const src = sourceClient(body);
    const dest = destClient();

    const out = await copyVerified(src, 'src-key', dest, 'dest-key', { contentType: 'text/plain' });

    expect(out).toEqual({ size: body.length, checksum: sha(body) });
    expect(dest.putFile).toHaveBeenCalledWith('dest-key', expect.any(String), 'text/plain');
    expect(dest._store['dest-key']).toEqual(body);
  });

  it('throws if the source does not match an expected checksum', async () => {
    const body = Buffer.from('payload');
    const src = sourceClient(body);
    const dest = destClient();

    await expect(
      copyVerified(src, 'k', dest, 'd', { expectedChecksum: 'deadbeef' })
    ).rejects.toBeInstanceOf(ChecksumMismatchError);
    // Source failed verification — nothing was written to the destination.
    expect(dest.putFile).not.toHaveBeenCalled();
  });

  it('throws when the destination read-back checksum differs (silent corruption)', async () => {
    const body = Buffer.from('payload-abc');
    const src = sourceClient(body);
    const dest = destClient({ corrupt: true });

    await expect(copyVerified(src, 'k', dest, 'd')).rejects.toMatchObject({ code: 'CHECKSUM_MISMATCH' });
  });

  it('throws when the destination size does not match', async () => {
    const body = Buffer.from('payload-xyz');
    const src = sourceClient(body);
    const dest = destClient({ sizeLie: 999 });

    await expect(copyVerified(src, 'k', dest, 'd')).rejects.toMatchObject({ code: 'CHECKSUM_MISMATCH' });
  });
});
