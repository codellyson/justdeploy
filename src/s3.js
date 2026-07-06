// Minimal S3-compatible PutObject with AWS Signature V4 — zero deps, works for AWS S3 and
// Cloudflare R2 (region "auto"). Path-style addressing: PUT {endpoint}/{bucket}/{key}.
// You bring the bucket + credentials; JustDeploy just pushes the archive here.
import { createHash, createHmac } from 'node:crypto';

const sha256hex = (data) => createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();

function signingKey(secret, dateStamp, region, service) {
  const kDate = hmac('AWS4' + secret, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

// RFC3986 encoding for a single path segment (encodeURIComponent leaves !*'() unescaped).
const enc = (s) => encodeURIComponent(s).replace(/[!*'()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

// config: { endpoint, region, bucket, accessKey, secretKey, prefix }
export async function putObject(config, keyName, body) {
  const { endpoint, region = 'auto', bucket, accessKey, secretKey, prefix = '' } = config;
  const origin = new URL(endpoint).origin;
  const host = new URL(endpoint).host;
  const key = (prefix ? prefix.replace(/\/+$/, '') + '/' : '') + keyName;
  const canonicalUri = '/' + [bucket, ...key.split('/')].map(enc).join('/');

  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, ''); // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256hex(body);
  const service = 's3';

  const canonicalHeaders =
    `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest =
    ['PUT', canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign =
    ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');
  const signature = createHmac('sha256', signingKey(secretKey, dateStamp, region, service))
    .update(stringToSign).digest('hex');
  const authorization =
    `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const res = await fetch(origin + canonicalUri, {
    method: 'PUT',
    headers: {
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      Authorization: authorization,
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`S3 PUT ${res.status}: ${text.slice(0, 300)}`);
  }
  return { key, url: origin + canonicalUri };
}
