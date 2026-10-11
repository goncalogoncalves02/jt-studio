alter table blog_private.admin_sessions
  add column auth_session_id uuid,
  add column cookie_digest bytea unique,
  add column token_ciphertext text,
  add column auth_expires_at timestamptz,
  add column refresh_claim_id uuid,
  add column refresh_claimed_at timestamptz;

create index admin_sessions_cookie_digest_idx on blog_private.admin_sessions (cookie_digest) where revoked_at is null;

create or replace function blog_private.create_admin_session(
  p_session_id uuid,
  p_user_id uuid,
  p_auth_session_id uuid,
  p_generation bigint,
  p_cookie_digest text,
  p_expires_at timestamptz,
  p_auth_expires_at timestamptz,
  p_token_ciphertext text
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, blog_private
as $$
begin
  if p_session_id is null or p_user_id is null or p_auth_session_id is null or p_generation <> 1
    or p_cookie_digest !~ '^[a-f0-9]{64}$'
    or p_expires_at <= clock_timestamp()
    or p_expires_at > clock_timestamp() + interval '30 days' + interval '1 minute'
    or p_auth_expires_at <= clock_timestamp()
    or p_token_ciphertext is null or length(p_token_ciphertext) > 16384
    or p_token_ciphertext !~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'
    or not exists (select 1 from blog_private.settings s where s.singleton and s.authorized_owner_id = p_user_id) then
    raise exception 'admin session is not authorized' using errcode = '42501';
  end if;
  insert into blog_private.admin_sessions (
    session_id, user_id, auth_session_id, generation, cookie_digest,
    expires_at, auth_expires_at, token_ciphertext
  ) values (
    p_session_id, p_user_id, p_auth_session_id, p_generation, decode(p_cookie_digest, 'hex'),
    p_expires_at, p_auth_expires_at, p_token_ciphertext
  );
  return true;
end;
$$;

create or replace function blog_private.lookup_admin_session(p_cookie_digest text)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, blog_private
as $$
  select jsonb_build_object(
    'session_id', s.session_id,
    'user_id', s.user_id,
    'auth_session_id', s.auth_session_id,
    'generation', s.generation,
    'expires_at', s.expires_at,
    'auth_expires_at', s.auth_expires_at,
    'token_ciphertext', s.token_ciphertext,
    'refresh_claim_id', s.refresh_claim_id
  )
  from blog_private.admin_sessions s
  join blog_private.settings a on a.singleton and a.authorized_owner_id = s.user_id
  where p_cookie_digest ~ '^[a-f0-9]{64}$'
    and s.cookie_digest = decode(p_cookie_digest, 'hex')
    and s.revoked_at is null
    and s.expires_at > clock_timestamp()
  limit 1;
$$;

create or replace function blog_private.claim_admin_session_refresh(
  p_session_id uuid,
  p_generation bigint,
  p_claim_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, blog_private
as $$
declare
  v_session blog_private.admin_sessions%rowtype;
begin
  update blog_private.admin_sessions s
    set refresh_claim_id = p_claim_id, refresh_claimed_at = clock_timestamp()
  where s.session_id = p_session_id
    and s.generation = p_generation
    and s.refresh_claim_id is null
    and s.revoked_at is null
    and s.expires_at > clock_timestamp()
    and exists (select 1 from blog_private.settings a where a.singleton and a.authorized_owner_id = s.user_id)
  returning s.* into v_session;
  if not found then return null; end if;
  return jsonb_build_object('claim_id', v_session.refresh_claim_id, 'generation', v_session.generation);
end;
$$;

create or replace function blog_private.complete_admin_session_refresh(
  p_session_id uuid,
  p_generation bigint,
  p_claim_id uuid,
  p_auth_expires_at timestamptz,
  p_token_ciphertext text
)
returns bigint
language plpgsql
security definer
set search_path = pg_catalog, blog_private
as $$
declare
  v_generation bigint;
begin
  if p_auth_expires_at <= clock_timestamp() or p_token_ciphertext is null or length(p_token_ciphertext) > 16384
    or p_token_ciphertext !~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$' then
    raise exception 'refreshed session credentials are invalid' using errcode = '22023';
  end if;
  update blog_private.admin_sessions s
    set generation = s.generation + 1,
        auth_expires_at = p_auth_expires_at,
        token_ciphertext = p_token_ciphertext,
        refresh_claim_id = null,
        refresh_claimed_at = null
  where s.session_id = p_session_id
    and s.generation = p_generation
    and s.refresh_claim_id = p_claim_id
    and s.revoked_at is null
    and s.expires_at > clock_timestamp()
    and exists (select 1 from blog_private.settings a where a.singleton and a.authorized_owner_id = s.user_id)
  returning s.generation into v_generation;
  return v_generation;
end;
$$;

create or replace function blog_private.fail_admin_session_refresh(
  p_session_id uuid,
  p_generation bigint,
  p_claim_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, blog_private
as $$
declare
  v_count integer;
begin
  update blog_private.admin_sessions s
    set revoked_at = coalesce(s.revoked_at, clock_timestamp()),
        refresh_claim_id = null,
        refresh_claimed_at = null
  where s.session_id = p_session_id
    and s.generation = p_generation
    and s.refresh_claim_id = p_claim_id
    and s.revoked_at is null;
  get diagnostics v_count = row_count;
  return v_count = 1;
end;
$$;

create or replace function blog_private.revoke_admin_session(p_session_id uuid, p_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, blog_private
as $$
declare
  v_count integer;
begin
  update blog_private.admin_sessions s
    set revoked_at = coalesce(s.revoked_at, clock_timestamp()),
        refresh_claim_id = null,
        refresh_claimed_at = null
  where s.session_id = p_session_id
    and s.user_id = p_user_id
    and s.revoked_at is null
    and s.expires_at > clock_timestamp()
    and exists (select 1 from blog_private.settings a where a.singleton and a.authorized_owner_id = s.user_id);
  get diagnostics v_count = row_count;
  return v_count = 1;
end;
$$;

create or replace function public.blog_admin_session_create(
  p_session_id uuid, p_user_id uuid, p_auth_session_id uuid, p_generation bigint,
  p_cookie_digest text, p_expires_at timestamptz, p_auth_expires_at timestamptz, p_token_ciphertext text
)
returns boolean
language sql
security definer
set search_path = pg_catalog, blog_private
as $$
  select blog_private.create_admin_session(p_session_id, p_user_id, p_auth_session_id, p_generation,
    p_cookie_digest, p_expires_at, p_auth_expires_at, p_token_ciphertext);
$$;

create or replace function public.blog_admin_session_lookup(p_cookie_digest text)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, blog_private
as $$ select blog_private.lookup_admin_session(p_cookie_digest); $$;

create or replace function public.blog_admin_session_refresh_claim(p_session_id uuid, p_generation bigint, p_claim_id uuid)
returns jsonb
language sql
security definer
set search_path = pg_catalog, blog_private
as $$ select blog_private.claim_admin_session_refresh(p_session_id, p_generation, p_claim_id); $$;

create or replace function public.blog_admin_session_refresh_complete(
  p_session_id uuid, p_generation bigint, p_claim_id uuid, p_auth_expires_at timestamptz, p_token_ciphertext text
)
returns bigint
language sql
security definer
set search_path = pg_catalog, blog_private
as $$ select blog_private.complete_admin_session_refresh(p_session_id, p_generation, p_claim_id, p_auth_expires_at, p_token_ciphertext); $$;

create or replace function public.blog_admin_session_refresh_fail(p_session_id uuid, p_generation bigint, p_claim_id uuid)
returns boolean
language sql
security definer
set search_path = pg_catalog, blog_private
as $$ select blog_private.fail_admin_session_refresh(p_session_id, p_generation, p_claim_id); $$;

create or replace function public.blog_admin_session_revoke(p_session_id uuid, p_user_id uuid)
returns boolean
language sql
security definer
set search_path = pg_catalog, blog_private
as $$ select blog_private.revoke_admin_session(p_session_id, p_user_id); $$;

revoke all on function blog_private.create_admin_session(uuid,uuid,uuid,bigint,text,timestamptz,timestamptz,text) from public, anon, authenticated, service_role;
revoke all on function blog_private.lookup_admin_session(text) from public, anon, authenticated, service_role;
revoke all on function blog_private.claim_admin_session_refresh(uuid,bigint,uuid) from public, anon, authenticated, service_role;
revoke all on function blog_private.complete_admin_session_refresh(uuid,bigint,uuid,timestamptz,text) from public, anon, authenticated, service_role;
revoke all on function blog_private.fail_admin_session_refresh(uuid,bigint,uuid) from public, anon, authenticated, service_role;
revoke all on function blog_private.revoke_admin_session(uuid,uuid) from public, anon, authenticated, service_role;

revoke all on function public.blog_admin_session_create(uuid,uuid,uuid,bigint,text,timestamptz,timestamptz,text) from public, anon, authenticated;
revoke all on function public.blog_admin_session_lookup(text) from public, anon, authenticated;
revoke all on function public.blog_admin_session_refresh_claim(uuid,bigint,uuid) from public, anon, authenticated;
revoke all on function public.blog_admin_session_refresh_complete(uuid,bigint,uuid,timestamptz,text) from public, anon, authenticated;
revoke all on function public.blog_admin_session_refresh_fail(uuid,bigint,uuid) from public, anon, authenticated;
revoke all on function public.blog_admin_session_revoke(uuid,uuid) from public, anon, authenticated;
grant execute on function public.blog_admin_session_create(uuid,uuid,uuid,bigint,text,timestamptz,timestamptz,text) to service_role;
grant execute on function public.blog_admin_session_lookup(text) to service_role;
grant execute on function public.blog_admin_session_refresh_claim(uuid,bigint,uuid) to service_role;
grant execute on function public.blog_admin_session_refresh_complete(uuid,bigint,uuid,timestamptz,text) to service_role;
grant execute on function public.blog_admin_session_refresh_fail(uuid,bigint,uuid) to service_role;
grant execute on function public.blog_admin_session_revoke(uuid,uuid) to service_role;
