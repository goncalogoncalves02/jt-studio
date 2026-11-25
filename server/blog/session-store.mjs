function requireRpcClient(client) {
  if (!client || typeof client.rpc !== 'function') throw new TypeError('Session store is unavailable');
  return client;
}

async function call(client, name, args) {
  const { data, error } = await requireRpcClient(client).rpc(name, args);
  if (error) throw new Error('The admin session store is unavailable.');
  return data;
}

export async function createAdminSession(client, input) {
  return call(client, 'blog_admin_session_create', {
    p_session_id: input.sessionId,
    p_user_id: input.userId,
    p_auth_session_id: input.authSessionId,
    p_generation: input.generation,
    p_cookie_digest: input.cookieDigest,
    p_expires_at: input.expiresAt,
    p_auth_expires_at: input.authExpiresAt,
    p_token_ciphertext: input.tokenCiphertext,
  });
}

export async function findAdminSession(client, cookieDigest) {
  const result = await call(client, 'blog_admin_session_lookup', { p_cookie_digest: cookieDigest });
  return result && typeof result === 'object' && !Array.isArray(result) ? result : null;
}

export async function claimAdminRefresh(client, input) {
  return call(client, 'blog_admin_session_refresh_claim', {
    p_session_id: input.sessionId,
    p_generation: input.generation,
    p_claim_id: input.claimId,
  });
}

export async function revokeAbandonedAdminRefresh(client, input) {
  return call(client, 'blog_admin_session_refresh_abandon', {
    p_session_id: input.sessionId,
    p_generation: input.generation,
    p_claim_id: input.claimId,
  });
}

export async function completeAdminRefresh(client, input) {
  return call(client, 'blog_admin_session_refresh_complete', {
    p_session_id: input.sessionId,
    p_generation: input.generation,
    p_claim_id: input.claimId,
    p_auth_expires_at: input.authExpiresAt,
    p_token_ciphertext: input.tokenCiphertext,
  });
}

export async function failAdminRefresh(client, input) {
  return call(client, 'blog_admin_session_refresh_fail', {
    p_session_id: input.sessionId,
    p_generation: input.generation,
    p_claim_id: input.claimId,
  });
}

export async function revokeAdminSession(client, input) {
  return call(client, 'blog_admin_session_revoke', {
    p_session_id: input.sessionId,
    p_user_id: input.userId,
  });
}
