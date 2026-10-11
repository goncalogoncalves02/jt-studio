import test from 'node:test';
import assert from 'node:assert/strict';
import { createBoundedFetch, readBlogConfig } from '../../server/blog/config.mjs';

const valid = {
  SUPABASE_URL: 'http://127.0.0.1:54341',
  SUPABASE_ANON_KEY: 'local-anon-key-long-enough-for-validation',
  SUPABASE_SERVICE_ROLE_KEY: 'local-service-role-key-long-enough-for-validation',
  BLOG_ADMIN_USER_ID: '1a2b3c4d-5e6f-4789-8abc-def012345678',
  BLOG_SESSION_ENCRYPTION_KEY: 'a'.repeat(64),
  BLOG_PUBLIC_ORIGIN: 'https://editor.example.test',
};

test('server config accepts the approved owner and public origin environment names', () => {
  const config = readBlogConfig(valid);
  assert.equal(config.ownerId, valid.BLOG_ADMIN_USER_ID);
  assert.equal(config.appOrigin, valid.BLOG_PUBLIC_ORIGIN);
  assert.equal(config.encryptionKey.length, 32);
});

test('server config does not accept unapproved owner/origin environment aliases', () => {
  const aliases = {
    ...valid,
    BLOG_ADMIN_USER_ID: undefined,
    BLOG_PUBLIC_ORIGIN: undefined,
    BLOG_ADMIN_OWNER_ID: valid.BLOG_ADMIN_USER_ID,
    BLOG_APP_ORIGIN: valid.BLOG_PUBLIC_ORIGIN,
  };
  assert.throws(() => readBlogConfig(aliases), error => error.status === 503);
});

test('bounded Supabase fetch preserves caller abort and imposes an independent timeout', async () => {
  const boundedFetch = createBoundedFetch(10, (_input, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
  }));
  await assert.rejects(boundedFetch('https://auth.example.test/user'), error => error.name === 'TimeoutError');
});
