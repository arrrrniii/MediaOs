const Minio = require('minio');
const config = require('./config');

const minioClient = new Minio.Client({
  endPoint: config.minio.endPoint,
  port: config.minio.port,
  useSSL: config.minio.useSSL,
  accessKey: config.minio.accessKey,
  secretKey: config.minio.secretKey,
});

async function ensureBucket() {
  const exists = await minioClient.bucketExists(config.bucket);
  if (!exists) {
    await minioClient.makeBucket(config.bucket);
    console.log(`Created MinIO bucket: ${config.bucket}`);
  }
}

async function putBuffer(key, buffer, contentType) {
  await minioClient.putObject(config.bucket, key, buffer, buffer.length, {
    'Content-Type': contentType,
    'Cache-Control': 'public, max-age=31536000, immutable',
  });
}

async function putFile(key, filePath, contentType) {
  await minioClient.fPutObject(config.bucket, key, filePath, {
    'Content-Type': contentType,
    'Cache-Control': 'public, max-age=31536000, immutable',
  });
}

async function getObject(key) {
  return minioClient.getObject(config.bucket, key);
}

async function getPartialObject(key, offset, length) {
  return minioClient.getPartialObject(config.bucket, key, offset, length);
}

async function statObject(key) {
  return minioClient.statObject(config.bucket, key);
}

async function removeObject(key) {
  await minioClient.removeObject(config.bucket, key);
}

module.exports = {
  minioClient,
  ensureBucket,
  putBuffer,
  putFile,
  getObject,
  getPartialObject,
  statObject,
  removeObject,
};
