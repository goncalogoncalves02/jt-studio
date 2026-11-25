import { createHmac, timingSafeEqual } from 'node:crypto';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export class CsrfError extends Error {
  constructor() {
    super('The request origin or CSRF token is invalid.');
    this.name = 'CsrfError';
    this.status = 403;
  }
}

export function createCsrfToken(key, sessionId) {
  if (!Buffer.isBuffer(key) || key.length !== 32 || !UUID_PATTERN.test(sessionId ?? '')) {
    throw new TypeError('CSRF context is invalid');
  }
  return createHmac('sha256', key).update(`jt-blog-csrf-v1:${sessionId.toLowerCase()}`).digest('base64url');
}

export function assertLoginRequest(request, expectedOrigin) {
  if (request.method !== 'POST' || request.headers.get('origin') !== expectedOrigin
      || request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    throw new CsrfError();
  }
}

export function assertCsrfRequest(request, expectedOrigin, expectedToken) {
  const supplied = request.headers.get('x-csrf-token') ?? '';
  const expected = typeof expectedToken === 'string' ? expectedToken : '';
  const suppliedBytes = Buffer.from(supplied, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)
      || request.headers.get('origin') !== expectedOrigin
      || request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json'
      || suppliedBytes.length < 32 || suppliedBytes.length > 128
      || suppliedBytes.length !== expectedBytes.length
      || !timingSafeEqual(suppliedBytes, expectedBytes)) {
    throw new CsrfError();
  }
}
