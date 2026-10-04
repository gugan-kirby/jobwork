import { hexToBase64, presignUrl, signRequest, type SigV4Credentials } from './sigv4';

export type StoreBucket = 'quarantine' | 'clean';

export interface SignedGrant {
  method: 'PUT';
  url: string;
  headers: Record<string, string>;
}

export interface ObjectMetadata {
  byteSize: number;
  sha256: string | null;
  etag: string | null;
}

export interface ObjectStoreConfig {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  quarantineBucket: string;
  cleanBucket: string;
  uploadTtlSeconds: number;
  downloadTtlSeconds: number;
  requestTimeoutMs?: number;
}

/** The store is unreachable or refused: block the flow, never guess a verdict (doc 12 §5). */
export class ObjectStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ObjectStoreError';
  }
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * S3-compatible private object storage (doc 04 §8), shared by the API and the scan
 * worker. Bytes never pass through the API: clients exchange short-lived,
 * single-purpose signed grants with the store directly (doc 08 §7). The API and the
 * worker use their own credentials for metadata, reads, and prefix moves.
 */
export class ObjectStoreClient {
  private readonly credentials: SigV4Credentials;

  constructor(private readonly config: ObjectStoreConfig) {
    this.credentials = {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      region: config.region,
    };
  }

  bucketName(bucket: StoreBucket): string {
    return bucket === 'quarantine' ? this.config.quarantineBucket : this.config.cleanBucket;
  }

  private path(bucket: StoreBucket, key: string): string {
    return `${this.bucketName(bucket)}/${key}`;
  }

  /**
   * Upload capability bound to one key, one method, one exact byte length and one
   * digest: the store rejects a payload that hashes differently, so tampered or
   * oversized bytes never land.
   */
  signUpload(input: {
    key: string;
    byteSize: number;
    sha256: string;
    contentType: string;
    ttlSeconds?: number;
  }): SignedGrant {
    const headers: Record<string, string> = {
      'content-length': String(input.byteSize),
      'content-type': input.contentType,
      'x-amz-checksum-sha256': hexToBase64(input.sha256),
    };
    const url = presignUrl(this.credentials, {
      endpoint: this.config.endpoint,
      objectPath: this.path('quarantine', input.key),
      method: 'PUT',
      expiresInSeconds: input.ttlSeconds ?? this.config.uploadTtlSeconds,
      signedRequestHeaders: headers,
    });
    return { method: 'PUT', url, headers };
  }

  /** Short-TTL read capability with a forced attachment disposition (doc 09 §4). */
  signDownload(input: {
    bucket: StoreBucket;
    key: string;
    filename: string;
    ttlSeconds?: number;
  }): string {
    return presignUrl(this.credentials, {
      endpoint: this.config.endpoint,
      objectPath: this.path(input.bucket, input.key),
      method: 'GET',
      expiresInSeconds: input.ttlSeconds ?? this.config.downloadTtlSeconds,
      query: {
        'response-content-disposition': `attachment; filename="${input.filename.replace(/["\\]/g, '_')}"`,
      },
    });
  }

  /** Returns null when the object is absent; throws only when the store itself fails. */
  async head(bucket: StoreBucket, key: string): Promise<ObjectMetadata | null> {
    const response = await this.send('HEAD', bucket, key, {
      'x-amz-checksum-mode': 'ENABLED',
    });
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new ObjectStoreError(`head failed with status ${response.status}`);
    }
    const checksum = response.headers.get('x-amz-checksum-sha256');
    return {
      byteSize: Number(response.headers.get('content-length') ?? '0'),
      sha256: checksum ? Buffer.from(checksum, 'base64').toString('hex') : null,
      etag: response.headers.get('etag'),
    };
  }

  /**
   * Reads an object into memory for inspection, refusing anything above the caller's
   * limit — the scanner must never be handed unbounded bytes (doc 11 §8).
   */
  async getBytes(bucket: StoreBucket, key: string, maxBytes: number): Promise<Buffer> {
    const response = await this.send('GET', bucket, key);
    if (!response.ok) {
      throw new ObjectStoreError(`get failed with status ${response.status}`);
    }
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > maxBytes) {
      throw new ObjectStoreError(`object exceeds the ${maxBytes} byte inspection limit`);
    }
    const body = Buffer.from(await response.arrayBuffer());
    if (body.byteLength > maxBytes) {
      throw new ObjectStoreError(`object exceeds the ${maxBytes} byte inspection limit`);
    }
    return body;
  }

  /** Promotes bytes out of quarantine once a scan clears them. */
  async copy(
    from: { bucket: StoreBucket; key: string },
    to: { bucket: StoreBucket; key: string },
  ): Promise<void> {
    const response = await this.send('PUT', to.bucket, to.key, {
      'x-amz-copy-source': `/${this.path(from.bucket, from.key)}`,
    });
    if (!response.ok) {
      throw new ObjectStoreError(`copy failed with status ${response.status}`);
    }
  }

  async remove(bucket: StoreBucket, key: string): Promise<void> {
    const response = await this.send('DELETE', bucket, key);
    if (!response.ok && response.status !== 404) {
      throw new ObjectStoreError(`delete failed with status ${response.status}`);
    }
  }

  private async send(
    method: 'GET' | 'HEAD' | 'PUT' | 'DELETE',
    bucket: StoreBucket,
    key: string,
    headers?: Record<string, string>,
  ): Promise<Response> {
    const signed = signRequest(this.credentials, {
      endpoint: this.config.endpoint,
      objectPath: this.path(bucket, key),
      method,
      ...(headers ? { headers } : {}),
    });
    try {
      return await fetch(signed.url, {
        method,
        headers: signed.headers,
        signal: AbortSignal.timeout(this.config.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch (cause) {
      throw new ObjectStoreError(
        `object store unreachable: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }
}
