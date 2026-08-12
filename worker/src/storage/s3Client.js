/**
 * S3-compatible storage client.
 *
 * Given a DECRYPTED backend config, returns the same uniform interface every
 * backend in this codebase exposes (see services/storageBackendService.js):
 *
 *   putBuffer(key, buffer, contentType)      -> Promise<void>
 *   putFile(key, filePath, contentType)      -> Promise<void>   (streamed)
 *   getObject(key)                           -> Promise<Readable>
 *   getPartialObject(key, offset, length)    -> Promise<Readable>
 *   statObject(key)                          -> Promise<{ size, etag }>
 *   removeObject(key)                        -> Promise<void>
 *   copyObjectFrom(srcClient, srcKey, key, contentType) -> Promise<{ size }>
 *
 * One implementation covers every S3-API backend the platform supports:
 *   - AWS S3           (region set, virtual-hosted style)
 *   - Cloudflare R2    (endpoint set, region 'auto', path style)
 *   - Backblaze B2     (S3-compatible endpoint, path style)
 *   - a secondary/remote MinIO (endpoint set, path style)
 * The only knobs that differ are endpoint / region / forcePathStyle, all of
 * which come from the (decrypted) config — so there is no per-vendor branch.
 *
 * Streaming: getObject/getPartialObject return the raw Node Readable from the
 * SDK response so large objects never buffer in memory; putFile streams a
 * fs.ReadStream. copyObjectFrom streams src.getObject -> putObject, which works
 * across two DIFFERENT backends (hot MinIO -> cold S3), unlike a same-bucket
 * server-side CopyObject.
 */

const fs = require('fs');
const {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} = require('@aws-sdk/client-s3');

/**
 * Build a uniform storage client from a decrypted backend config.
 * @param {object} cfg
 * @param {string} cfg.endpoint        e.g. https://<acct>.r2.cloudflarestorage.com (omit for AWS)
 * @param {string} cfg.region          e.g. us-east-1 / auto
 * @param {string} cfg.bucket
 * @param {string} cfg.accessKeyId
 * @param {string} cfg.secretAccessKey
 * @param {boolean} [cfg.forcePathStyle]  true for MinIO/B2/R2
 */
function createS3Client(cfg) {
  if (!cfg || !cfg.bucket) {
    throw new Error('S3 client requires a config with at least { bucket }');
  }
  const bucket = cfg.bucket;

  const clientOptions = {
    region: cfg.region || 'us-east-1',
    forcePathStyle: cfg.forcePathStyle !== false && !!cfg.endpoint,
    credentials: cfg.accessKeyId
      ? { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey }
      : undefined,
  };
  if (cfg.endpoint) clientOptions.endpoint = cfg.endpoint;
  // R2/B2/MinIO want path-style; AWS (no endpoint) wants virtual-hosted.
  if (cfg.forcePathStyle === true) clientOptions.forcePathStyle = true;

  const s3 = new S3Client(clientOptions);

  async function putBuffer(key, buffer, contentType) {
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: buffer,
      ContentLength: buffer.length,
      ContentType: contentType,
      CacheControl: 'public, max-age=31536000, immutable',
    }));
  }

  async function putFile(key, filePath, contentType) {
    const size = fs.statSync(filePath).size;
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: fs.createReadStream(filePath),
      ContentLength: size,
      ContentType: contentType,
      CacheControl: 'public, max-age=31536000, immutable',
    }));
  }

  /** Stream a whole object. Returns the SDK's Node Readable body. */
  async function getObject(key) {
    const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return out.Body; // Readable (Node runtime)
  }

  /** Stream a byte range [offset, offset+length). */
  async function getPartialObject(key, offset, length) {
    const end = offset + length - 1;
    const out = await s3.send(new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      Range: `bytes=${offset}-${end}`,
    }));
    return out.Body;
  }

  async function statObject(key) {
    const out = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return {
      size: typeof out.ContentLength === 'number' ? out.ContentLength : Number(out.ContentLength || 0),
      etag: out.ETag ? out.ETag.replace(/"/g, '') : undefined,
    };
  }

  async function removeObject(key) {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }

  /**
   * Copy an object from another (possibly different-vendor) backend into this
   * one by streaming src.getObject -> putObject. Used by the archiver to move
   * bytes hot -> cold across two distinct backends. Returns the byte count.
   */
  async function copyObjectFrom(srcClient, srcKey, destKey, contentType) {
    let size = 0;
    try {
      const stat = await srcClient.statObject(srcKey);
      size = stat.size || 0;
    } catch {
      // size unknown; PutObject can still stream without ContentLength for
      // some backends, but S3 requires it — fall back to buffering below.
    }
    const body = await srcClient.getObject(srcKey);
    if (size > 0) {
      await s3.send(new PutObjectCommand({
        Bucket: bucket, Key: destKey, Body: body, ContentLength: size, ContentType: contentType,
        CacheControl: 'public, max-age=31536000, immutable',
      }));
      return { size };
    }
    // No known length — buffer the stream so we can set ContentLength.
    const chunks = [];
    for await (const chunk of body) chunks.push(chunk);
    const buf = Buffer.concat(chunks);
    await putBuffer(destKey, buf, contentType);
    return { size: buf.length };
  }

  return {
    _s3: s3,
    bucket,
    putBuffer,
    putFile,
    getObject,
    getPartialObject,
    statObject,
    removeObject,
    copyObjectFrom,
  };
}

module.exports = { createS3Client };
