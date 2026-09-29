import { createHash, createHmac } from 'node:crypto';
import { Readable } from 'node:stream';
import type { ObjectStore } from './storage.js';

// An S3 compatible object store (Amazon S3, MinIO, Cloudflare R2, Wasabi and
// others) for recordings, so several API servers share them. Requests are
// signed with AWS Signature Version 4, which every such service accepts.

export interface S3Options {
  /** For example https://s3.af-south-1.amazonaws.com or http://localhost:9000 for MinIO. */
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Bucket in the path (MinIO and most others) rather than in the host name. */
  pathStyle: boolean;
  /** Ask the service to encrypt each object at rest, for example AES256. */
  serverSideEncryption?: string | undefined;
  fetch?: typeof fetch;
  now?: () => Date;
}

const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data).digest();

/** Encodes a path segment the way Signature Version 4 expects. */
function encode(segment: string): string {
  return encodeURIComponent(segment).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export interface SignInput {
  method: string;
  url: URL;
  headers: Record<string, string>;
  payloadHash: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service: string;
  date: Date;
}

/** Returns the headers to send, including x-amz-date and Authorization. */
export function signV4(input: SignInput): Record<string, string> {
  const amzDate = input.date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const day = amzDate.slice(0, 8);
  const headers: Record<string, string> = {
    ...input.headers,
    host: input.url.host,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': input.payloadHash,
  };
  const names = Object.keys(headers)
    .map((k) => k.toLowerCase())
    .sort();
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')]));
  const query = [...input.url.searchParams.entries()]
    .map(([k, v]) => [encode(k), encode(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const canonical = [
    input.method,
    input.url.pathname.split('/').map((s) => encode(decodeURIComponent(s))).join('/') || '/',
    query,
    names.map((n) => `${n}:${lower[n]}\n`).join(''),
    names.join(';'),
    input.payloadHash,
  ].join('\n');
  const scope = `${day}/${input.region}/${input.service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, hash(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, day), input.region), input.service), 'aws4_request');
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`,
  };
}

export function s3Store(opts: S3Options): ObjectStore {
  const doFetch = opts.fetch ?? fetch;
  const urlFor = (key: string) => {
    const base = new URL(opts.endpoint);
    const path = key.split('/').map(encode).join('/');
    if (opts.pathStyle) return new URL(`${base.origin}/${encode(opts.bucket)}/${path}`);
    return new URL(`${base.protocol}//${opts.bucket}.${base.host}/${path}`);
  };
  const send = async (method: string, key: string, body?: Buffer, extra: Record<string, string> = {}) => {
    const url = urlFor(key);
    const headers = signV4({
      method,
      url,
      headers: extra,
      payloadHash: hash(body ?? ''),
      accessKeyId: opts.accessKeyId,
      secretAccessKey: opts.secretAccessKey,
      region: opts.region,
      service: 's3',
      date: (opts.now ?? (() => new Date()))(),
    });
    delete headers.host;
    return doFetch(url, { method, headers, ...(body ? { body: new Uint8Array(body) } : {}) });
  };

  return {
    async put(key, body) {
      const res = await send('PUT', key, body, {
        'content-length': String(body.length),
        ...(opts.serverSideEncryption ? { 'x-amz-server-side-encryption': opts.serverSideEncryption } : {}),
      });
      if (!res.ok) throw new Error(`Storage refused the recording (${res.status}): ${(await res.text()).slice(0, 200)}`);
    },
    async get(key) {
      const res = await send('GET', key);
      if (res.status === 404) return null;
      if (!res.ok || !res.body) throw new Error(`Storage could not return the recording (${res.status})`);
      return { stream: Readable.fromWeb(res.body as never), size: Number(res.headers.get('content-length') ?? 0) };
    },
    async delete(key) {
      const res = await send('DELETE', key);
      if (!res.ok && res.status !== 404) throw new Error(`Storage could not delete the recording (${res.status})`);
    },
  };
}
