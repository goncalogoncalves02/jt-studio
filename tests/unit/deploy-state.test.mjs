import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNetlifyClient, verifyDeployEvidence } from '../../server/blog/netlify-api.mjs';
import { createPublicationService } from '../../server/blog/publication.mjs';
import { buildBlog } from '../../scripts/build-blog.mjs';
import {
  acquireBuild,
  assertBuildCurrent,
  parseIncomingHookBody,
} from '../../scripts/production-release.mjs';

const requestId = '5117c4e2-1f8d-41b4-b630-9c99e9958605';
const releaseId = 'a8ff489b-89d0-4426-961a-58ac0c99115d';
const attemptId = '720cf4d0-8061-45d0-bf30-831ceecbf89b';
const siteId = 'site-jt-studio-123';
const deployId = '6740abc123def456';
const prevDeployId = '6740prev00000001';
const publicOrigin = 'https://jaquelinetakiutistudio.com';

function releaseEnvelope(id = releaseId) {
  const payload = JSON.stringify({ schemaVersion: 1, releaseId: id, posts: [] });
  const digest = createHash('sha256').update(payload, 'utf8').digest('hex');
  return { releaseId: id, payload, digest };
}

function baseBuildEnv(extra = {}) {
  return {
    SUPABASE_URL: 'https://proj.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-secret-long-enough-for-test',
    DEPLOY_ID: deployId,
    CONTEXT: 'production',
    BRANCH: 'main',
    BLOG_PUBLIC_ORIGIN: publicOrigin,
    ...extra,
  };
}

function sessionAuth() {
  return {
    userId: '5117c4e2-1f8d-41b4-b630-9c99e9958605',
    sessionId: '720cf4d0-8061-45d0-bf30-831ceecbf89b',
    authSessionId: 'a8ff489b-89d0-4426-961a-58ac0c99115d',
    generation: 7,
    userSdk: { rpc: async () => ({ data: { releaseId, payload: '{}', digest: 'a'.repeat(64) }, error: null }) },
    serviceClient: {
      rpc: async () => ({ data: { requestId, releaseId, state: 'confirmed' }, error: null }),
    },
  };
}

test('parseIncomingHookBody distinguishes absent body from hook-without-body and malformed payloads', () => {
  assert.equal(parseIncomingHookBody({}), null);

  assert.throws(
    () => parseIncomingHookBody({ INCOMING_HOOK_URL: 'https://api.netlify.com/build_hooks/abc12345' }),
    /hook without body/i,
  );
  assert.throws(
    () => parseIncomingHookBody({ INCOMING_HOOK_TITLE: 'editorial-publish' }),
    /hook without body/i,
  );

  for (const bad of [
    '',
    '   ',
    '%ZZ',
    'not-json',
    encodeURIComponent('[]'),
    encodeURIComponent(JSON.stringify({ requestId, releaseId })),
    encodeURIComponent(JSON.stringify({ requestId, releaseId, attemptId, extra: 1 })),
    encodeURIComponent(JSON.stringify({ requestId: 'not-a-uuid', releaseId, attemptId })),
  ]) {
    assert.throws(() => parseIncomingHookBody({ INCOMING_HOOK_BODY: bad }), /malformed/i);
  }

  const encoded = encodeURIComponent(JSON.stringify({
    requestId: requestId.toUpperCase(),
    releaseId,
    attemptId,
  }));
  assert.deepEqual(parseIncomingHookBody({ INCOMING_HOOK_BODY: encoded }), {
    requestId,
    releaseId,
    attemptId,
  });
});

test('acquireBuild rejects non-production contexts, non-main branches, missing DEPLOY_ID, site mismatch, and insecure storage origin', async () => {
  await assert.rejects(
    acquireBuild({ env: baseBuildEnv({ CONTEXT: 'deploy-preview' }), rpc: async () => ({}) }),
    /production/i,
  );
  await assert.rejects(
    acquireBuild({ env: baseBuildEnv({ BRANCH: 'feature/other' }), rpc: async () => ({}) }),
    /main/i,
  );
  await assert.rejects(
    acquireBuild({ env: baseBuildEnv({ DEPLOY_ID: '' }), rpc: async () => ({}) }),
    /DEPLOY_ID/i,
  );
  await assert.rejects(
    acquireBuild({ env: baseBuildEnv({ BLOG_NETLIFY_SITE_ID: siteId, SITE_ID: 'wrong-site' }), rpc: async () => ({}) }),
    /SITE_ID/i,
  );
  await assert.rejects(
    acquireBuild({ env: baseBuildEnv({ SUPABASE_URL: 'http://127.0.0.1:54341' }), rpc: async () => ({}) }),
    /origin/i,
  );
});

test('acquireBuild claims slot before returning digest-verified immutable release and assertBuildCurrent fences completion', async () => {
  const env = baseBuildEnv({
    INCOMING_HOOK_BODY: encodeURIComponent(JSON.stringify({ requestId, releaseId, attemptId })),
  });
  const envelope = releaseEnvelope();
  const calls = [];
  const rpc = async (name, args) => {
    calls.push({ name, args });
    if (name === 'blog_build_active_code_slot') {
      return { data: { active: false }, error: null };
    }
    if (name === 'blog_build_acquire') {
      return {
        data: {
          ...envelope,
          deployId,
          generation: 3,
          buildKind: 'editorial',
          requestId,
          attemptId,
        },
        error: null,
      };
    }
    if (name === 'blog_build_assert_current') {
      return { data: { ok: true, deployId, releaseId, generation: 3 }, error: null };
    }
    throw new Error(`unexpected rpc ${name}`);
  };

  const acquired = await acquireBuild({ env, rpc });
  assert.equal(acquired.releaseId, releaseId);
  assert.equal(acquired.deployId, deployId);
  assert.equal(acquired.generation, 3);
  assert.equal(acquired.buildKind, 'editorial');
  assert.equal(acquired.publicStorageOrigin, 'https://proj.supabase.co');
  assert.deepEqual(calls[1], {
    name: 'blog_build_acquire',
    args: { p_deploy_id: deployId, p_hook_payload: { requestId, releaseId, attemptId } },
  });

  await assertBuildCurrent({ deployId, releaseId, generation: 3, rpc });
  assert.deepEqual(calls[2], {
    name: 'blog_build_assert_current',
    args: { p_deploy_id: deployId, p_release_id: releaseId, p_generation: 3 },
  });
});

test('acquireBuild reconciles a previous completed code slot before acquiring, and never releases its own active deployId', async () => {
  const envelope = releaseEnvelope();
  const calls = [];
  const netlifyClient = {
    siteId,
    getDeploy: async (id) => ({ deployId: id, siteId, context: 'production', branch: 'main', state: 'ready' }),
    getSitePublishedDeploy: async () => ({ siteId, publishedDeployId: prevDeployId }),
    getPublicReleaseManifest: async () => ({ releaseId, deployId: prevDeployId, digest: envelope.digest, schema: 1 }),
  };

  await acquireBuild({
    env: baseBuildEnv({ BLOG_NETLIFY_SITE_ID: siteId, SITE_ID: siteId }),
    netlifyClient,
    rpc: async (name, args) => {
      calls.push({ name, args });
      if (name === 'blog_build_active_code_slot') {
        return { data: { active: true, deployId: prevDeployId, generation: 2, releaseId, expectedDigest: envelope.digest }, error: null };
      }
      if (name === 'blog_build_release_code_slot') {
        return { data: { released: true, deployId: prevDeployId, outcome: 'ready', generation: 3 }, error: null };
      }
      if (name === 'blog_build_acquire') {
        return { data: { ...envelope, deployId, generation: 3, buildKind: 'code' }, error: null };
      }
      throw new Error(`unexpected rpc ${name}`);
    },
  });
  assert.deepEqual(calls.map((c) => c.name), [
    'blog_build_active_code_slot',
    'blog_build_release_code_slot',
    'blog_build_acquire',
  ]);
  assert.equal(calls[1].args.p_outcome, 'ready');
  assert.equal(calls[1].args.p_published_deploy_id, prevDeployId);

  const ownCalls = [];
  await acquireBuild({
    env: baseBuildEnv({ DEPLOY_ID: prevDeployId }),
    netlifyClient,
    rpc: async (name) => {
      ownCalls.push(name);
      if (name === 'blog_build_active_code_slot') {
        return { data: { active: true, deployId: prevDeployId, generation: 2, releaseId, expectedDigest: envelope.digest }, error: null };
      }
      if (name === 'blog_build_acquire') {
        return { data: { ...envelope, deployId: prevDeployId, generation: 2, buildKind: 'code' }, error: null };
      }
      throw new Error(`unexpected rpc ${name}`);
    },
  });
  assert.deepEqual(ownCalls, ['blog_build_active_code_slot', 'blog_build_acquire']);
});

test('confirmPublication reconciles an active terminal code slot before freezing editorial release', async () => {
  const envelope = releaseEnvelope();
  const calls = [];
  const auth = sessionAuth();
  auth.serviceClient = {
    rpc: async (name) => {
      calls.push(`service:${name}`);
      if (name === 'blog_publication_status') return { data: { requestId, releaseId, state: 'confirmed' }, error: null };
      throw new Error(`unexpected service rpc ${name}`);
    },
  };
  auth.userSdk = {
    rpc: async (name) => {
      calls.push(`user:${name}`);
      return { data: envelope, error: null };
    },
  };
  const service = createPublicationService({
    hookUrl: 'https://api.netlify.com/build_hooks/abc12345',
    netlifyClient: {
      siteId,
      getDeploy: async () => ({ deployId: prevDeployId, siteId, context: 'production', branch: 'main', state: 'error' }),
      getSitePublishedDeploy: async () => ({ siteId, publishedDeployId: 'older-live-deploy' }),
      getPublicReleaseManifest: async () => { throw new Error('should not fetch manifest'); },
    },
    rpc: async (name, args) => {
      calls.push({ name, args });
      if (name === 'blog_build_active_code_slot') {
        return { data: { active: true, deployId: prevDeployId, generation: 4, releaseId, expectedDigest: envelope.digest }, error: null };
      }
      if (name === 'blog_build_release_code_slot') {
        return { data: { released: true, deployId: prevDeployId, outcome: 'failed', generation: 5 }, error: null };
      }
      throw new Error(`unexpected rpc ${name}`);
    },
  });

  const status = await service.confirmPublication(auth, { requestId, expectedDigest: 'b'.repeat(64) });
  assert.equal(status.state, 'confirmed');
  assert.equal(calls[0].name, 'blog_build_active_code_slot');
  assert.equal(calls[1].name, 'blog_build_release_code_slot');
  assert.equal(calls[1].args.p_outcome, 'failed');
  assert.equal(calls[1].args.p_published_deploy_id, 'older-live-deploy');
  assert.equal(calls[2], 'user:blog_freeze_release');
});

test('buildBlog production failure produces no empty dist output', async () => {
  const tempOut = await mkdtemp(join(tmpdir(), 'jt-prod-fail-'));
  const targetDir = join(tempOut, 'dist');
  try {
    await assert.rejects(
      buildBlog({
        mode: 'production',
        outDir: targetDir,
        env: baseBuildEnv(),
        rpc: async (name) => {
          if (name === 'blog_build_active_code_slot') return { data: { active: false }, error: null };
          return { data: null, error: { code: '40001' } };
        },
      }),
      /acquire/i,
    );
    assert.equal(existsSync(targetDir), false);
  } finally {
    await rm(tempOut, { recursive: true, force: true });
  }
});

test('buildBlog production succeeds with synthetic nonempty release in tmp and leaves no output if final assertBuildCurrent fails', async () => {
  const tempOut = await mkdtemp(join(tmpdir(), 'jt-prod-ok-'));
  const targetDir = join(tempOut, 'dist');
  const failDir = join(tempOut, 'dist-assert-fail');
  const postId = '22222222-2222-4222-8222-222222222222';
  const payload = JSON.stringify({
    schemaVersion: 1,
    releaseId,
    posts: [{
      id: postId,
      slug: 'probe-post',
      title: 'Probe Post',
      excerpt: 'Probe excerpt',
      document: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Probe body' }] }] },
      coverMedia: null,
      media: [],
      serviceId: null,
      publishedAt: '2026-10-13T10:00:00Z',
      modifiedAt: '2026-10-13T10:00:00Z',
    }],
  });
  const digest = createHash('sha256').update(payload, 'utf8').digest('hex');

  try {
    const built = await buildBlog({
      mode: 'production',
      outDir: targetDir,
      env: baseBuildEnv(),
      rpc: async (name) => {
        if (name === 'blog_build_active_code_slot') return { data: { active: false }, error: null };
        if (name === 'blog_build_acquire') return { data: { releaseId, payload, digest, generation: 5, deployId, buildKind: 'code' }, error: null };
        if (name === 'blog_build_assert_current') return { data: { ok: true, deployId, releaseId, generation: 5 }, error: null };
        throw new Error(`unexpected rpc ${name}`);
      },
    });
    assert.equal(built.releaseId, releaseId);
    assert.equal(existsSync(join(targetDir, 'blog-release.json')), true);
    assert.equal(existsSync(join(targetDir, 'blog', 'probe-post.html')), true);
    assert.equal(existsSync(join(targetDir, 'sitemap.xml')), true);

    await mkdirForExisting(failDir);
    await assert.rejects(
      buildBlog({
        mode: 'production',
        outDir: failDir,
        env: baseBuildEnv(),
        rpc: async (name) => {
          if (name === 'blog_build_active_code_slot') return { data: { active: false }, error: null };
          if (name === 'blog_build_acquire') return { data: { releaseId, payload, digest, generation: 5, deployId, buildKind: 'code' }, error: null };
          if (name === 'blog_build_assert_current') return { data: null, error: { code: '40001' } };
          throw new Error(`unexpected rpc ${name}`);
        },
      }),
      /assertion failed/i,
    );
    assert.equal(await readFile(join(failDir, 'existing.html'), 'utf8'), 'keep-existing');
  } finally {
    await rm(tempOut, { recursive: true, force: true });
  }
});

async function mkdirForExisting(dir) {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'existing.html'), 'keep-existing');
}

test('createNetlifyClient uses fixed Netlify API origin, rejects redirects, and returns sanitized evidence', async () => {
  const seen = [];
  const client = createNetlifyClient({
    siteId,
    apiToken: 'super-secret-pat-token',
    publicOrigin,
    fetchImpl: async (url, init) => {
      seen.push({ url, init });
      if (url === `https://api.netlify.com/api/v1/deploys/${deployId}`) {
        return new Response(JSON.stringify({
          id: deployId,
          site_id: siteId,
          context: 'production',
          branch: 'main',
          state: 'ready',
          secret_env: 'should-not-leak',
        }), { status: 200 });
      }
      if (url === `https://api.netlify.com/api/v1/sites/${siteId}`) {
        return new Response(JSON.stringify({
          id: siteId,
          published_deploy: { id: deployId },
          admin_url: 'https://app.netlify.com/internal',
        }), { status: 200 });
      }
      if (url === `${publicOrigin}/blog-release.json`) {
        return new Response(JSON.stringify({
          releaseId,
          deployId,
          digest: 'a'.repeat(64),
          schema: 1,
        }), { status: 200 });
      }
      return new Response(null, { status: 404 });
    },
  });

  const deploy = await client.getDeploy(deployId);
  assert.deepEqual(deploy, {
    deployId,
    siteId,
    context: 'production',
    branch: 'main',
    state: 'ready',
  });
  assert.equal('secret_env' in deploy, false);
  assert.equal(seen[0].init.redirect, 'error');
  assert.equal(seen[0].init.headers.authorization, 'Bearer super-secret-pat-token');

  const site = await client.getSitePublishedDeploy();
  assert.deepEqual(site, { siteId, publishedDeployId: deployId });
  assert.equal(seen[1].init.redirect, 'error');

  const manifest = await client.getPublicReleaseManifest();
  assert.deepEqual(manifest, {
    releaseId,
    deployId,
    digest: 'a'.repeat(64),
    schema: 1,
  });
  assert.equal(seen[2].init.redirect, 'error');
});

test('verifyDeployEvidence and reconcilePublication keep slot blocked on ready-unpublished, missing published pointer on error, wrong context, 404, or timeout', async () => {
  const envelope = releaseEnvelope();
  const baseContext = {
    requestId,
    releaseId,
    state: 'building',
    attemptId,
    publicationGeneration: 7,
    slotGeneration: 7,
    activeRequestId: requestId,
    activeDeployId: deployId,
    activeBuildKind: 'editorial',
    activeBuildReleaseId: releaseId,
    expectedDigest: envelope.digest,
  };

  for (const scenario of [
    {
      name: 'ready but unpublished deploy',
      deploy: { deployId, siteId, context: 'production', branch: 'main', state: 'ready' },
      site: { siteId, publishedDeployId: 'other-old-deploy' },
    },
    {
      name: 'error state with missing published pointer',
      deploy: { deployId, siteId, context: 'production', branch: 'main', state: 'error' },
      site: { siteId, publishedDeployId: null },
    },
    {
      name: 'error state when deployId is still publishedDeployId',
      deploy: { deployId, siteId, context: 'production', branch: 'main', state: 'error' },
      site: { siteId, publishedDeployId: deployId },
    },
    {
      name: 'preview context deploy',
      deploy: { deployId, siteId, context: 'deploy-preview', branch: 'main', state: 'ready' },
      site: { siteId, publishedDeployId: deployId },
    },
    {
      name: 'wrong site id',
      deploy: { deployId, siteId: 'wrong-site', context: 'production', branch: 'main', state: 'ready' },
      site: { siteId, publishedDeployId: deployId },
    },
    {
      name: '404 from Netlify API',
      throwOnDeploy: Object.assign(new Error('not found'), { status: 404 }),
    },
    {
      name: 'timeout from Netlify API',
      throwOnDeploy: new DOMException('timeout', 'TimeoutError'),
    },
  ]) {
    const netlifyClient = {
      siteId,
      getDeploy: async () => {
        if (scenario.throwOnDeploy) throw scenario.throwOnDeploy;
        return scenario.deploy;
      },
      getSitePublishedDeploy: async () => scenario.site,
      getPublicReleaseManifest: async () => ({ releaseId, deployId, digest: envelope.digest, schema: 1 }),
    };

    const direct = await verifyDeployEvidence({
      netlifyClient,
      deployId,
      releaseId,
      expectedDigest: envelope.digest,
    });
    assert.equal(direct.outcome, 'pending', scenario.name);

    const commits = [];
    const service = createPublicationService({
      hookUrl: 'https://api.netlify.com/build_hooks/abc12345',
      rpc: async (name, args) => {
        if (name === 'blog_publication_reconcile_read') return { data: baseContext, error: null };
        if (name === 'blog_publication_reconcile_commit') {
          commits.push(args);
          return { data: { requestId, releaseId, state: args.p_outcome, deployId }, error: null };
        }
        throw new Error(`unexpected rpc ${name}`);
      },
      netlifyClient,
    });
    const status = await service.reconcilePublication(sessionAuth(), { requestId });
    assert.notEqual(status.state, 'live', scenario.name);
    assert.notEqual(status.state, 'failed', scenario.name);
    assert.equal('evidence' in status, false, scenario.name);
    assert.equal(commits.length, 0, scenario.name);
  }
});

test('reconcilePublication marks live only when deploy, published pointer, and /blog-release.json match and rejects stale CAS', async () => {
  const envelope = releaseEnvelope();
  const baseContext = {
    requestId,
    releaseId,
    state: 'building',
    attemptId,
    publicationGeneration: 7,
    slotGeneration: 7,
    activeRequestId: requestId,
    activeDeployId: deployId,
    activeBuildKind: 'editorial',
    activeBuildReleaseId: releaseId,
    expectedDigest: envelope.digest,
  };
  let commitArgs;
  const service = createPublicationService({
    hookUrl: 'https://api.netlify.com/build_hooks/abc12345',
    rpc: async (name, args) => {
      if (name === 'blog_publication_reconcile_read') return { data: baseContext, error: null };
      if (name === 'blog_publication_reconcile_commit') {
        commitArgs = args;
        return { data: { requestId, releaseId, state: 'live', deployId }, error: null };
      }
      throw new Error(`unexpected rpc ${name}`);
    },
    netlifyClient: {
      siteId,
      getDeploy: async () => ({ deployId, siteId, context: 'production', branch: 'main', state: 'ready' }),
      getSitePublishedDeploy: async () => ({ siteId, publishedDeployId: deployId }),
      getPublicReleaseManifest: async () => ({ releaseId, deployId, digest: envelope.digest, schema: 1 }),
    },
  });

  const status = await service.reconcilePublication(sessionAuth(), { requestId });
  assert.equal(status.state, 'live');
  assert.equal('evidence' in status, false);
  assert.equal(commitArgs.p_outcome, 'live');
  assert.equal(commitArgs.p_publication_generation, 7);
  assert.equal(commitArgs.p_deploy_id, deployId);

  const staleService = createPublicationService({
    hookUrl: 'https://api.netlify.com/build_hooks/abc12345',
    rpc: async (name) => {
      if (name === 'blog_publication_reconcile_read') return { data: baseContext, error: null };
      if (name === 'blog_publication_reconcile_commit') return { data: null, error: { code: '40001' } };
      throw new Error(`unexpected rpc ${name}`);
    },
    netlifyClient: {
      siteId,
      getDeploy: async () => ({ deployId, siteId, context: 'production', branch: 'main', state: 'error' }),
      getSitePublishedDeploy: async () => ({ siteId, publishedDeployId: 'older-deploy' }),
      getPublicReleaseManifest: async () => { throw new Error('should not fetch manifest on failed deploy'); },
    },
  });
  await assert.rejects(
    staleService.reconcilePublication(sessionAuth(), { requestId }),
    (error) => error.status === 409,
  );
});
