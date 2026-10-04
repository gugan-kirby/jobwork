import { Injectable } from '@nestjs/common';
import {
  ObjectStoreClient,
  ObjectStoreError,
  type ObjectMetadata,
  type SignedGrant,
  type StoreBucket,
} from '@jobwork/object-store';
import { ConfigService } from '../../../platform/config/config.service';
import { DomainError } from '../../../platform/http/domain-error';

export type { ObjectMetadata, SignedGrant, StoreBucket };

/** Object storage is unreachable: block the flow, never guess a verdict (doc 12 §5). */
export class ObjectStoreUnavailable extends DomainError {
  constructor(detail?: string) {
    super(
      'OBJECT_STORE_UNAVAILABLE',
      503,
      'File storage is temporarily unavailable',
      detail ?? 'Try again shortly.',
    );
  }
}

/**
 * The API's view of private object storage: the shared client (used by the scan worker
 * too) wrapped so store failures surface as problem-details rather than raw errors.
 */
@Injectable()
export class ObjectStore {
  private readonly client: ObjectStoreClient;

  constructor(config: ConfigService) {
    this.client = new ObjectStoreClient({
      endpoint: config.env.OBJECT_STORE_ENDPOINT,
      region: config.env.OBJECT_STORE_REGION,
      accessKeyId: config.env.OBJECT_STORE_ACCESS_KEY,
      secretAccessKey: config.env.OBJECT_STORE_SECRET_KEY,
      quarantineBucket: config.env.OBJECT_STORE_BUCKET_QUARANTINE,
      cleanBucket: config.env.OBJECT_STORE_BUCKET_CLEAN,
      uploadTtlSeconds: config.env.UPLOAD_GRANT_TTL_SECONDS,
      downloadTtlSeconds: config.env.DOWNLOAD_GRANT_TTL_SECONDS,
    });
  }

  bucketName(bucket: StoreBucket): string {
    return this.client.bucketName(bucket);
  }

  signUpload(input: {
    key: string;
    byteSize: number;
    sha256: string;
    contentType: string;
    ttlSeconds?: number;
  }): SignedGrant {
    return this.client.signUpload(input);
  }

  signDownload(input: {
    bucket: StoreBucket;
    key: string;
    filename: string;
    ttlSeconds?: number;
  }): string {
    return this.client.signDownload(input);
  }

  head(bucket: StoreBucket, key: string): Promise<ObjectMetadata | null> {
    return this.guard(() => this.client.head(bucket, key));
  }

  copy(
    from: { bucket: StoreBucket; key: string },
    to: { bucket: StoreBucket; key: string },
  ): Promise<void> {
    return this.guard(() => this.client.copy(from, to));
  }

  remove(bucket: StoreBucket, key: string): Promise<void> {
    return this.guard(() => this.client.remove(bucket, key));
  }

  private async guard<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (cause) {
      if (cause instanceof ObjectStoreError) throw new ObjectStoreUnavailable(cause.message);
      throw cause;
    }
  }
}
