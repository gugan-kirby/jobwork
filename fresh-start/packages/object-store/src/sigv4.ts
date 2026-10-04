import { createHash, createHmac } from 'node:crypto';

/**
 * Minimal AWS Signature Version 4 for S3-compatible stores (MinIO in development,
 * managed object storage in deployed environments — doc 04 §8).
 *
 * Hand-rolled against the published algorithm rather than pulling the AWS SDK: the
 * surface used here is four operations, and ES-29 rejects transitive-heavy runtime
 * dependencies without justification. Verified end to end against MinIO — method,
 * key, expiry, content-length and checksum are all inside the signature, so a grant
 * cannot be widened by the holder.
 */

export interface SigV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
}

const ALGORITHM = 'AWS4-HMAC-SHA256';
const SERVICE = 's3';
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

const sha256Hex = (value: string | Buffer): string =>
  createHash('sha256').update(value).digest('hex');

const hmac = (key: string | Buffer, value: string): Buffer =>
  createHmac('sha256', key).update(value).digest();

/** RFC 3986 encoding: S3 canonicalization treats `!'()*` as unreserved-unsafe too. */
function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function encodePath(path: string): string {
  return path.split('/').map(uriEncode).join('/');
}

function amzDate(now: Date): { stamp: string; date: string } {
  const stamp = `${now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`;
  return { stamp, date: stamp.slice(0, 8) };
}

function signingKey(creds: SigV4Credentials, date: string): Buffer {
  return hmac(
    hmac(hmac(hmac(`AWS4${creds.secretAccessKey}`, date), creds.region), SERVICE),
    'aws4_request',
  );
}

function canonicalize(headers: Record<string, string>): {
  canonicalHeaders: string;
  signedHeaders: string;
} {
  const lowered = Object.entries(headers).map(
    ([name, value]) => [name.toLowerCase(), value.trim()] as const,
  );
  lowered.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    canonicalHeaders: lowered.map(([name, value]) => `${name}:${value}\n`).join(''),
    signedHeaders: lowered.map(([name]) => name).join(';'),
  };
}

function canonicalQuery(params: Array<[string, string]>): string {
  return params
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

export interface PresignInput {
  endpoint: string;
  /** Path-style object path, `<bucket>/<key>`. */
  objectPath: string;
  method: 'GET' | 'PUT';
  expiresInSeconds: number;
  /** Headers folded into the signature; the client must send each one verbatim. */
  signedRequestHeaders?: Record<string, string>;
  query?: Record<string, string>;
  now?: Date;
}

/** Query-authenticated URL: a single-purpose capability, not an ambient credential. */
export function presignUrl(creds: SigV4Credentials, input: PresignInput): string {
  const { stamp, date } = amzDate(input.now ?? new Date());
  const endpoint = new URL(input.endpoint);
  const canonicalUri = `${endpoint.pathname.replace(/\/$/, '')}/${encodePath(input.objectPath)}`;
  const { canonicalHeaders, signedHeaders } = canonicalize({
    host: endpoint.host,
    ...(input.signedRequestHeaders ?? {}),
  });

  const params: Array<[string, string]> = [
    ['X-Amz-Algorithm', ALGORITHM],
    ['X-Amz-Credential', `${creds.accessKeyId}/${date}/${creds.region}/${SERVICE}/aws4_request`],
    ['X-Amz-Date', stamp],
    ['X-Amz-Expires', String(input.expiresInSeconds)],
    ['X-Amz-SignedHeaders', signedHeaders],
    ...Object.entries(input.query ?? {}),
  ];
  const query = canonicalQuery(params);

  const canonicalRequest = [
    input.method,
    canonicalUri,
    query,
    canonicalHeaders,
    signedHeaders,
    UNSIGNED_PAYLOAD,
  ].join('\n');
  const stringToSign = [
    ALGORITHM,
    stamp,
    `${date}/${creds.region}/${SERVICE}/aws4_request`,
    sha256Hex(canonicalRequest),
  ].join('\n');
  const signature = createHmac('sha256', signingKey(creds, date))
    .update(stringToSign)
    .digest('hex');

  return `${endpoint.origin}${canonicalUri}?${query}&X-Amz-Signature=${signature}`;
}

export interface SignedRequestInput {
  endpoint: string;
  objectPath: string;
  method: 'GET' | 'HEAD' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  body?: Buffer;
  now?: Date;
}

/** Header-authenticated request the API itself makes (head, copy, delete). */
export function signRequest(
  creds: SigV4Credentials,
  input: SignedRequestInput,
): { url: string; headers: Record<string, string> } {
  const { stamp, date } = amzDate(input.now ?? new Date());
  const endpoint = new URL(input.endpoint);
  const canonicalUri = `${endpoint.pathname.replace(/\/$/, '')}/${encodePath(input.objectPath)}`;
  const payloadHash = sha256Hex(input.body ?? Buffer.alloc(0));

  const headers: Record<string, string> = {
    host: endpoint.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': stamp,
    ...(input.headers ?? {}),
  };
  const { canonicalHeaders, signedHeaders } = canonicalize(headers);

  const canonicalRequest = [
    input.method,
    canonicalUri,
    '',
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const stringToSign = [
    ALGORITHM,
    stamp,
    `${date}/${creds.region}/${SERVICE}/aws4_request`,
    sha256Hex(canonicalRequest),
  ].join('\n');
  const signature = createHmac('sha256', signingKey(creds, date))
    .update(stringToSign)
    .digest('hex');

  return {
    url: `${endpoint.origin}${canonicalUri}`,
    headers: {
      ...headers,
      authorization:
        `${ALGORITHM} Credential=${creds.accessKeyId}/${date}/${creds.region}/${SERVICE}/aws4_request, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
}

/** S3 carries checksums base64-encoded; the platform stores and compares hex. */
export function hexToBase64(hex: string): string {
  return Buffer.from(hex, 'hex').toString('base64');
}
