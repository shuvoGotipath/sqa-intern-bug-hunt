import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadBucketCommand } from '@aws-sdk/client-s3';

/**
 * File storage for CVs and evidence screenshots. Objects are private; the app
 * streams them to authorised users only. Two drivers share one interface:
 *   put(key, buffer, contentType)  get(key) -> Readable | null  delete(key)
 */

export class S3Storage {
  constructor({ endpoint, region, bucket, accessKeyId, secretAccessKey }) {
    this.bucket = bucket;
    this.client = new S3Client({
      endpoint,
      region: region || 'auto',
      forcePathStyle: true,
      credentials: { accessKeyId, secretAccessKey },
    });
  }
  async check() {
    await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
  }
  async put(key, buffer, contentType) {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: buffer, ContentType: contentType }));
  }
  async get(key) {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      return res.Body;
    } catch (err) {
      if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) return null;
      throw err;
    }
  }
  async delete(key) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

/** Local-disk driver, used for tests and when no S3 settings are configured. */
export class LocalStorage {
  constructor(dir) {
    this.dir = path.resolve(dir);
  }
  resolve(key) {
    const full = path.resolve(this.dir, key);
    if (!full.startsWith(this.dir + path.sep)) throw new Error('Invalid storage key');
    return full;
  }
  async check() {
    fs.mkdirSync(this.dir, { recursive: true });
  }
  async put(key, buffer) {
    const full = this.resolve(key);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, buffer, { mode: 0o600 });
  }
  async get(key) {
    const full = this.resolve(key);
    return fs.existsSync(full) ? fs.createReadStream(full) : null;
  }
  async delete(key) {
    fs.rmSync(this.resolve(key), { force: true });
  }
}

export function storageFromEnv(env, fallbackDir) {
  const { S3_ENDPOINT, S3_REGION, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY } = env;
  if (S3_BUCKET && S3_ACCESS_KEY_ID && S3_SECRET_ACCESS_KEY) {
    return new S3Storage({ endpoint: S3_ENDPOINT, region: S3_REGION, bucket: S3_BUCKET, accessKeyId: S3_ACCESS_KEY_ID, secretAccessKey: S3_SECRET_ACCESS_KEY });
  }
  return new LocalStorage(fallbackDir);
}

/** Pipes a stored object to the response; returns false if it does not exist. */
export async function sendStored(storage, key, res) {
  const body = await storage.get(key);
  if (!body) return false;
  const stream = body instanceof Readable ? body : Readable.fromWeb(body);
  await new Promise((resolve, reject) => {
    stream.on('error', reject);
    res.on('finish', resolve);
    res.on('close', resolve);
    stream.pipe(res);
  });
  return true;
}

/** Reads a stored object fully into memory; returns null if it does not exist. */
export async function readStored(storage, key) {
  const body = await storage.get(key);
  if (!body) return null;
  const stream = body instanceof Readable ? body : Readable.fromWeb(body);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}
