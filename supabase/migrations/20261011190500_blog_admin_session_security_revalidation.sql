create or replace function blog_private.revalidate_admin_session(p_session_id uuid, p_generation bigint, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, blog_private, auth
as $$
declare
  v_auth_session_id text := (select auth.jwt() ->> 'session_id');
begin
  if p_user_id is null or p_user_id is distinct from (select auth.uid())
    or v_auth_session_id is null
    or not exists (
      select 1 from blog_private.admin_sessions s
      where s.session_id = p_session_id
        and s.user_id = p_user_id
        and s.auth_session_id::text = v_auth_session_id
        and s.generation = p_generation
        and s.revoked_at is null
        and s.expires_at > clock_timestamp()
    )
    or not exists (
      select 1 from blog_private.settings s
      where s.singleton and s.authorized_owner_id = p_user_id
    ) then
    raise exception 'editor authorization is required' using errcode = '42501';
  end if;
end;
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
  select s.* into v_session
  from blog_private.admin_sessions s
  where s.session_id = p_session_id
  for update;
  if not found
    or v_session.generation <> p_generation
    or v_session.refresh_claim_id is not null
    or v_session.revoked_at is not null
    or v_session.expires_at <= clock_timestamp()
    or not exists (select 1 from blog_private.settings a where a.singleton and a.authorized_owner_id = v_session.user_id) then
    return null;
  end if;

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
  v_session blog_private.admin_sessions%rowtype;
  v_generation bigint;
begin
  if p_auth_expires_at <= clock_timestamp() or p_token_ciphertext is null or length(p_token_ciphertext) > 16384
    or p_token_ciphertext !~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$' then
    raise exception 'refreshed session credentials are invalid' using errcode = '22023';
  end if;

  select s.* into v_session
  from blog_private.admin_sessions s
  where s.session_id = p_session_id
  for update;
  if not found
    or v_session.generation <> p_generation
    or v_session.refresh_claim_id is distinct from p_claim_id
    or v_session.revoked_at is not null
    or v_session.expires_at <= clock_timestamp()
    or not exists (select 1 from blog_private.settings a where a.singleton and a.authorized_owner_id = v_session.user_id) then
    return null;
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

create or replace function blog_private.revoke_abandoned_admin_session_refresh(
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
  v_session blog_private.admin_sessions%rowtype;
  v_count integer;
begin
  select s.* into v_session
  from blog_private.admin_sessions s
  where s.session_id = p_session_id
  for update;
  if not found
    or v_session.generation <> p_generation
    or v_session.refresh_claim_id is distinct from p_claim_id
    or v_session.revoked_at is not null
    or v_session.refresh_claimed_at is null
    or v_session.refresh_claimed_at > clock_timestamp() - interval '45 seconds'
    or v_session.expires_at <= clock_timestamp()
    or not exists (select 1 from blog_private.settings a where a.singleton and a.authorized_owner_id = v_session.user_id) then
    return false;
  end if;

  update blog_private.admin_sessions s
  set revoked_at = clock_timestamp(), refresh_claim_id = null, refresh_claimed_at = null
  where s.session_id = p_session_id
    and s.generation = p_generation
    and s.refresh_claim_id = p_claim_id
    and s.revoked_at is null
    and s.refresh_claimed_at <= clock_timestamp() - interval '45 seconds'
    and s.expires_at > clock_timestamp()
    and exists (select 1 from blog_private.settings a where a.singleton and a.authorized_owner_id = s.user_id);
  get diagnostics v_count = row_count;
  return v_count = 1;
end;
$$;

create or replace function public.blog_admin_session_refresh_abandon(p_session_id uuid, p_generation bigint, p_claim_id uuid)
returns boolean
language sql
security definer
set search_path = pg_catalog, blog_private
as $$ select blog_private.revoke_abandoned_admin_session_refresh(p_session_id, p_generation, p_claim_id); $$;

revoke all on function blog_private.revalidate_admin_session(uuid,bigint,uuid) from public, anon, authenticated, service_role;
revoke all on function blog_private.claim_admin_session_refresh(uuid,bigint,uuid) from public, anon, authenticated, service_role;
revoke all on function blog_private.complete_admin_session_refresh(uuid,bigint,uuid,timestamptz,text) from public, anon, authenticated, service_role;
revoke all on function blog_private.revoke_abandoned_admin_session_refresh(uuid,bigint,uuid) from public, anon, authenticated, service_role;
revoke all on function public.blog_admin_session_refresh_abandon(uuid,bigint,uuid) from public, anon, authenticated;
grant execute on function public.blog_admin_session_refresh_abandon(uuid,bigint,uuid) to service_role;
