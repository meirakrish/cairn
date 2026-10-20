import {
  DeleteObjectCommand,
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { NotFoundError } from './errors';

/** Where uploaded originals live. Garage in dev, any S3-compatible store in the cloud, memory in tests. */
export interface ObjectStore {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  /** Throws NotFoundError if there is no such object. */
  get(key: string): Promise<Uint8Array>;
  /** Succeeds if the object is already gone. */
  delete(key: string): Promise<void>;
}

export interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export class S3ObjectStore implements ObjectStore {
  private client: S3Client;

  constructor(private config: S3Config) {
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
      // Garage (like MinIO) serves buckets by path, not by subdomain.
      forcePathStyle: true,
    });
  }

  async put(key: string, body: Uint8Array, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async get(key: string): Promise<Uint8Array> {
    try {
      const res = await this.client.send(
        new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
      );
      return await res.Body!.transformToByteArray();
    } catch (err) {
      if (err instanceof NoSuchKey) throw new NotFoundError('object');
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }));
  }

  close(): void {
    this.client.destroy();
  }
}

export class MemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, { body: Uint8Array; contentType: string }>();

  async put(key: string, body: Uint8Array, contentType: string): Promise<void> {
    this.objects.set(key, { body: new Uint8Array(body), contentType });
  }

  async get(key: string): Promise<Uint8Array> {
    const object = this.objects.get(key);
    if (!object) throw new NotFoundError('object');
    return object.body;
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}
