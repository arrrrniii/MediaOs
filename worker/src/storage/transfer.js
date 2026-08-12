/**
 * Verified object transfer between two storage backends.
 *
 * The archiver (hot -> cold) and the restorer (cold -> hot) both need to copy
 * an object's bytes from one backend to another and PROVE the copy is intact
 * before anything destructive happens. Both go through copyVerified here.
 *
 * How it stays memory-safe for large objects: the source is streamed to a
 * temp file while a running SHA-256 is computed, then that temp file is
 * streamed into the destination via putFile. The destination copy is then read
 * back and re-hashed, and the two hashes (plus sizes) are compared. Nothing
 * larger than a chunk is ever held in memory. The temp file is always removed.
 *
 * Uses only the uniform client interface (getObject / statObject / putFile),
 * so it works for every backend type — local MinIO, remote MinIO, S3, R2, B2 —
 * in any source/destination combination.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');

function tmpFile() {
  return path.join(os.tmpdir(), `mediaos-xfer-${process.pid}-${crypto.randomBytes(8).toString('hex')}`);
}

/** Stream a source object to a temp file, returning its size + sha256. */
async function streamToTemp(srcClient, srcKey) {
  const dest = tmpFile();
  const hash = crypto.createHash('sha256');
  const src = await srcClient.getObject(srcKey);
  const out = fs.createWriteStream(dest);
  src.on('data', (chunk) => hash.update(chunk));
  await pipeline(src, out);
  const size = fs.statSync(dest).size;
  return { path: dest, size, checksum: hash.digest('hex') };
}

/** Read an object back from a backend and return its size + sha256. */
async function hashRemote(client, key) {
  const hash = crypto.createHash('sha256');
  const stream = await client.getObject(key);
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    hash.update(chunk);
  }
  return { size, checksum: hash.digest('hex') };
}

class ChecksumMismatchError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'ChecksumMismatchError';
    this.code = 'CHECKSUM_MISMATCH';
    this.detail = detail || {};
  }
}

/**
 * Copy srcKey on srcClient to destKey on destClient and verify the destination
 * copy byte-for-byte via checksum + size before returning.
 *
 * @param {object}   srcClient
 * @param {string}   srcKey
 * @param {object}   destClient
 * @param {string}   destKey
 * @param {object}   [opts]
 * @param {string}   [opts.contentType]        stored on the destination object
 * @param {string}   [opts.expectedChecksum]   if set, the source AND destination
 *                                              must match it; otherwise the
 *                                              source checksum becomes the
 *                                              expected value for the dest check.
 * @returns {Promise<{ size:number, checksum:string }>}
 * @throws {ChecksumMismatchError} if source or destination fails verification.
 */
async function copyVerified(srcClient, srcKey, destClient, destKey, opts = {}) {
  const { contentType = 'application/octet-stream', expectedChecksum = null } = opts;
  let temp = null;
  try {
    temp = await streamToTemp(srcClient, srcKey);

    // If the caller supplied an authoritative checksum, the bytes we just read
    // from the source must already match it — a source-side mismatch means the
    // hot copy is corrupt and we must not propagate it to cold.
    if (expectedChecksum && temp.checksum !== expectedChecksum) {
      throw new ChecksumMismatchError('source object failed checksum verification', {
        srcKey, expected: expectedChecksum, actual: temp.checksum, side: 'source',
      });
    }

    await destClient.putFile(destKey, temp.path, contentType);

    // Verify the destination independently: size via statObject, bytes via a
    // full re-hash read-back.
    const expected = expectedChecksum || temp.checksum;
    let stat;
    try {
      stat = await destClient.statObject(destKey);
    } catch (err) {
      throw new ChecksumMismatchError('destination object not readable after copy', {
        destKey, error: err.message, side: 'destination',
      });
    }
    if (Number(stat.size) !== temp.size) {
      throw new ChecksumMismatchError('destination size mismatch', {
        destKey, expected: temp.size, actual: Number(stat.size), side: 'destination',
      });
    }
    const back = await hashRemote(destClient, destKey);
    if (back.checksum !== expected) {
      throw new ChecksumMismatchError('destination checksum mismatch', {
        destKey, expected, actual: back.checksum, side: 'destination',
      });
    }

    return { size: temp.size, checksum: expected };
  } finally {
    if (temp && temp.path) {
      fs.promises.unlink(temp.path).catch(() => {});
    }
  }
}

module.exports = { copyVerified, streamToTemp, hashRemote, ChecksumMismatchError };
