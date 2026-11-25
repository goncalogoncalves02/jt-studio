alter table blog_private.build_slot
  add column active_deploy_id text,
  add column active_build_kind text check (active_build_kind in ('editorial', 'code')),
  add column active_build_release_id uuid references blog_private.releases (release_id) on delete restrict,
  add column active_build_generation bigint,
  add column active_attempt_id uuid,
  add column lease_expires_at timestamptz,
  add column last_published_deploy_id text,
  add column last_published_release_id uuid references blog_private.releases (release_id) on delete restrict;

create table blog_private.reconciled_deploys (
  deploy_id text primary key check (deploy_id ~ '^[A-Za-z0-9._-]{1,128}$'),
  build_kind text not null check (build_kind in ('editorial', 'code')),
  release_id uuid not null references blog_private.releases (release_id) on delete restrict,
  outcome text not null check (outcome in ('live', 'ready', 'failed')),
  reconciled_at timestamptz not null default clock_timestamp()
);
revoke all on blog_private.reconciled_deploys from public, anon, authenticated, service_role;

create or replace function public.blog_freeze_release(p_request_id uuid, p_generation bigint, p_session_id uuid, p_expected_digest text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, blog_private, public, auth, extensions
as $$
declare
  v_owner uuid;
  v_auth_session uuid;
  v_active uuid;
  v_active_deploy text;
  v_request blog_private.publication_requests%rowtype;
  v_result jsonb;
  v_generation bigint;
begin
  select s.user_id, s.auth_session_id into v_owner, v_auth_session
  from blog_private.admin_sessions s
  where s.session_id = p_session_id and s.generation = p_generation
  for update;
  if not found or v_owner is distinct from auth.uid()
    or v_auth_session::text is distinct from auth.jwt() ->> 'session_id'
    or not blog_private.media_admin_session_live(v_owner, p_session_id, p_generation) then
    raise exception 'editor authorization is required' using errcode = '42501';
  end if;
  if p_request_id is null or p_expected_digest is null or p_expected_digest !~ '^[a-f0-9]{64}$' then
    raise exception 'publication request identity and digest are required' using errcode = '22023';
  end if;
  perform 1 from blog_private.build_slot where singleton for update;
  if not blog_private.media_admin_session_live(v_owner, p_session_id, p_generation) then
    raise exception 'editor authorization is required' using errcode = '42501';
  end if;
  select active_request_id, active_deploy_id, generation
  into v_active, v_active_deploy, v_generation
  from blog_private.build_slot where singleton;
  select * into v_request from blog_private.publication_requests where request_id = p_request_id for update;
  if found then
    if v_request.owner_id is distinct from v_owner or v_request.expected_summary_digest is distinct from p_expected_digest
      or v_active is distinct from p_request_id or v_request.publication_generation is distinct from v_generation then
      raise exception 'publication request is no longer the active immutable request' using errcode = '40001';
    end if;
    return public.blog_freeze_release_compose(p_request_id, p_generation, p_session_id, p_expected_digest);
  end if;
  if v_active is not null or v_active_deploy is not null then
    raise exception 'another publication or build is active' using errcode = '40001';
  end if;

  v_result := public.blog_freeze_release_compose(p_request_id, p_generation, p_session_id, p_expected_digest);
  select generation into v_generation from blog_private.build_slot where singleton;
  update blog_private.publication_requests set publication_generation = v_generation
  where request_id = p_request_id and owner_id = v_owner;
  if not found then raise exception 'publication reservation failed' using errcode = '40001'; end if;
  update blog_private.build_slot set active_request_id = p_request_id, updated_at = clock_timestamp() where singleton;
  return v_result;
end;
$$;

create or replace function public.blog_publication_dispatch_claim(
  p_user_id uuid, p_session_id uuid, p_auth_session_id uuid, p_generation bigint, p_request_id uuid, p_attempt_id uuid
) returns jsonb language plpgsql security definer
set search_path = pg_catalog, blog_private, public, auth
as $$
declare
  v_request blog_private.publication_requests%rowtype;
  v_active uuid;
  v_generation bigint;
  v_previous blog_private.publication_dispatch_attempts%rowtype;
begin
  if auth.role() <> 'service_role' or p_attempt_id is null then raise exception 'publication authority required' using errcode = '42501'; end if;
  if not blog_private.media_admin_session_live(p_user_id, p_session_id, p_generation)
    or not exists(select 1 from blog_private.admin_sessions s where s.session_id = p_session_id and s.user_id = p_user_id and s.auth_session_id = p_auth_session_id)
    or not exists(select 1 from auth.sessions a where a.id = p_auth_session_id and a.user_id = p_user_id and (a.not_after is null or a.not_after > clock_timestamp())) then
    raise exception 'editor authorization is required' using errcode = '42501';
  end if;
  perform 1 from blog_private.build_slot where singleton for update;
  if not blog_private.media_admin_session_live(p_user_id, p_session_id, p_generation) then raise exception 'editor authorization is required' using errcode = '42501'; end if;
  select active_request_id, generation into v_active, v_generation from blog_private.build_slot where singleton;
  select * into v_request from blog_private.publication_requests where request_id = p_request_id and owner_id = p_user_id for update;
  if not found or v_active is distinct from p_request_id or v_request.publication_generation is distinct from v_generation then
    raise exception 'publication is not active' using errcode = '40001';
  end if;
  select * into v_previous
  from blog_private.publication_dispatch_attempts
  where request_id = p_request_id and state <> 'failed'
  order by claimed_at limit 1;
  if found then
    return jsonb_build_object('claimed', false, 'status', jsonb_build_object(
      'requestId', p_request_id,
      'releaseId', v_request.release_id,
      'state', case when v_request.state in ('building', 'live', 'failed') then v_request.state when v_previous.state = 'queued' then 'queued' else 'unknown' end,
      'attemptId', v_previous.attempt_id
    ));
  end if;
  if v_request.state <> 'confirmed' or exists(
    select 1 from jsonb_array_elements(blog_private.v_payload_json(v_request.release_id)->'posts') post
    cross join lateral jsonb_array_elements(coalesce(post->'media','[]'::jsonb)||case when post->'coverMedia' is null or post->'coverMedia'='null'::jsonb then '[]'::jsonb else jsonb_build_array(post->'coverMedia') end) media
    cross join lateral jsonb_array_elements(coalesce(media->'variants','[]'::jsonb)) variant
    left join blog_private.publication_variant_progress progress on progress.request_id = p_request_id and progress.media_id = media->>'id' and progress.width = (variant->>'width')::integer
    where progress.request_id is null and not blog_private.publication_variant_was_in_base(p_request_id, media->>'id', (variant->>'width')::integer)
  ) then raise exception 'publication media promotion is incomplete' using errcode = '40001'; end if;
  insert into blog_private.publication_dispatch_attempts(request_id, attempt_id, publication_generation, state)
  values(p_request_id, p_attempt_id, v_generation, 'claimed');
  return jsonb_build_object('claimed', true, 'requestId', p_request_id, 'releaseId', v_request.release_id, 'attemptId', p_attempt_id, 'generation', v_generation);
end;
$$;

create or replace function public.blog_publication_dispatch_result(
  p_user_id uuid, p_session_id uuid, p_auth_session_id uuid, p_generation bigint, p_request_id uuid, p_attempt_id uuid, p_state text
) returns jsonb language plpgsql security definer
set search_path = pg_catalog, blog_private, public, auth
as $$
declare
  v_request blog_private.publication_requests%rowtype;
  v_attempt blog_private.publication_dispatch_attempts%rowtype;
  v_slot blog_private.build_slot%rowtype;
begin
  if auth.role() <> 'service_role' or p_state not in ('queued', 'unknown') then raise exception 'publication authority required' using errcode = '42501'; end if;
  if not blog_private.media_admin_session_live(p_user_id, p_session_id, p_generation)
    or not exists(select 1 from blog_private.admin_sessions s where s.session_id = p_session_id and s.user_id = p_user_id and s.auth_session_id = p_auth_session_id)
    or not exists(select 1 from auth.sessions a where a.id = p_auth_session_id and a.user_id = p_user_id and (a.not_after is null or a.not_after > clock_timestamp())) then
    raise exception 'editor authorization is required' using errcode = '42501';
  end if;
  select * into v_slot from blog_private.build_slot where singleton for update;
  if not blog_private.media_admin_session_live(p_user_id, p_session_id, p_generation) then raise exception 'editor authorization is required' using errcode = '42501'; end if;
  select * into v_request from blog_private.publication_requests where request_id = p_request_id and owner_id = p_user_id for update;
  if not found or v_slot.active_request_id is distinct from p_request_id or v_slot.generation is distinct from v_request.publication_generation then
    raise exception 'publication attempt is stale' using errcode = '40001';
  end if;
  select * into v_attempt from blog_private.publication_dispatch_attempts where request_id = p_request_id and attempt_id = p_attempt_id for update;
  if not found or v_attempt.publication_generation is distinct from v_request.publication_generation then
    raise exception 'publication attempt is stale' using errcode = '40001';
  end if;
  -- Never downgrade an already acquired/reconciled status or already-settled attempt.
  if v_request.state in ('building', 'live', 'failed') or v_slot.active_deploy_id is not null then
    return jsonb_build_object('requestId', p_request_id, 'releaseId', v_request.release_id, 'attemptId', p_attempt_id, 'state', v_request.state);
  end if;
  if v_attempt.state in ('queued', 'unknown', 'failed') then
    return jsonb_build_object('requestId', p_request_id, 'releaseId', v_request.release_id, 'attemptId', p_attempt_id, 'state', v_attempt.state);
  end if;
  update blog_private.publication_dispatch_attempts set state = p_state, updated_at = clock_timestamp() where request_id = p_request_id and attempt_id = p_attempt_id;
  update blog_private.publication_requests set state = p_state, updated_at = clock_timestamp() where request_id = p_request_id and state in ('confirmed', 'queued', 'unknown');
  return jsonb_build_object('requestId', p_request_id, 'releaseId', v_request.release_id, 'attemptId', p_attempt_id, 'state', p_state);
end;
$$;

create or replace function public.blog_publication_status(
  p_user_id uuid, p_session_id uuid, p_auth_session_id uuid, p_generation bigint, p_request_id uuid
) returns jsonb language plpgsql security definer
set search_path = pg_catalog, blog_private, public, auth
as $$
declare
  v_request blog_private.publication_requests%rowtype;
  v_attempt blog_private.publication_dispatch_attempts%rowtype;
  v_slot blog_private.build_slot%rowtype;
  v_state text;
begin
  if auth.role() <> 'service_role' or not blog_private.media_admin_session_live(p_user_id, p_session_id, p_generation)
    or not exists(select 1 from blog_private.admin_sessions s where s.session_id = p_session_id and s.auth_session_id = p_auth_session_id and s.user_id = p_user_id)
    or not exists(select 1 from auth.sessions a where a.id = p_auth_session_id and a.user_id = p_user_id and (a.not_after is null or a.not_after > clock_timestamp())) then
    raise exception 'editor authorization is required' using errcode = '42501';
  end if;
  perform 1 from blog_private.build_slot where singleton for update;
  if not blog_private.media_admin_session_live(p_user_id, p_session_id, p_generation) then raise exception 'editor authorization is required' using errcode = '42501'; end if;
  select * into v_slot from blog_private.build_slot where singleton;
  select * into v_request from blog_private.publication_requests where request_id = p_request_id and owner_id = p_user_id;
  if not found then raise exception 'publication is stale' using errcode = '40001'; end if;
  select * into v_attempt from blog_private.publication_dispatch_attempts where request_id = p_request_id order by claimed_at desc limit 1;
  if v_request.state = 'live' then
    return jsonb_build_object(
      'requestId', p_request_id,
      'releaseId', v_request.release_id,
      'state', v_request.state,
      'attemptId', v_attempt.attempt_id,
      'deployId', (
        select rd.deploy_id from blog_private.reconciled_deploys rd
        where rd.release_id = v_request.release_id and rd.build_kind = 'editorial' and rd.outcome = 'live'
        limit 1
      )
    );
  end if;
  if v_slot.active_request_id is distinct from p_request_id or v_request.publication_generation is distinct from v_slot.generation then
    raise exception 'publication is stale' using errcode = '40001';
  end if;
  if v_request.state in ('building', 'failed') then
    v_state := v_request.state;
  elsif found and v_attempt.state <> 'failed' then
    v_state := case when v_attempt.state = 'queued' then 'queued' else 'unknown' end;
  elsif v_request.state = 'confirmed' and exists(select 1 from blog_private.publication_variant_progress p where p.request_id = p_request_id) then
    v_state := 'promoting';
  else
    v_state := v_request.state;
  end if;
  return jsonb_build_object(
    'requestId', p_request_id,
    'releaseId', v_request.release_id,
    'state', v_state,
    'attemptId', v_attempt.attempt_id,
    'deployId', v_slot.active_deploy_id
  );
end;
$$;

create or replace function public.blog_publication_retry(
  p_user_id uuid, p_session_id uuid, p_auth_session_id uuid, p_generation bigint, p_request_id uuid, p_retry_id uuid
) returns jsonb language plpgsql security definer
set search_path = pg_catalog, blog_private, public, auth
as $$
declare
  v_request blog_private.publication_requests%rowtype;
  v_slot blog_private.build_slot%rowtype;
begin
  if auth.role() <> 'service_role' or p_retry_id is null
    or not blog_private.media_admin_session_live(p_user_id, p_session_id, p_generation)
    or not exists(select 1 from blog_private.admin_sessions s where s.session_id = p_session_id and s.user_id = p_user_id and s.auth_session_id = p_auth_session_id)
    or not exists(select 1 from auth.sessions a where a.id = p_auth_session_id and a.user_id = p_user_id and (a.not_after is null or a.not_after > clock_timestamp())) then
    raise exception 'editor authorization is required' using errcode = '42501';
  end if;
  select * into v_slot from blog_private.build_slot where singleton for update;
  if not blog_private.media_admin_session_live(p_user_id, p_session_id, p_generation) then raise exception 'editor authorization is required' using errcode = '42501'; end if;
  select * into v_request from blog_private.publication_requests where request_id = p_request_id and owner_id = p_user_id for update;
  if not found then raise exception 'publication is stale' using errcode = '40001'; end if;
  if exists(select 1 from blog_private.publication_retry_receipts where request_id = p_request_id and retry_id = p_retry_id) then
    return jsonb_build_object('requestId', p_request_id, 'releaseId', v_request.release_id, 'state', v_request.state);
  end if;
  if v_slot.active_request_id is distinct from p_request_id
    or v_slot.active_deploy_id is not null
    or v_request.publication_generation is distinct from v_slot.generation
    or v_request.release_id is distinct from v_slot.latest_confirmed_release_id
    or v_request.state <> 'failed'
    or exists(select 1 from blog_private.publication_dispatch_attempts where request_id = p_request_id and state <> 'failed') then
    raise exception 'only the active demonstrated failure can be retried' using errcode = '40001';
  end if;
  insert into blog_private.publication_retry_receipts(request_id, retry_id, publication_generation)
  values(p_request_id, p_retry_id, v_slot.generation);
  update blog_private.publication_requests set state = 'confirmed', updated_at = clock_timestamp() where request_id = p_request_id;
  return jsonb_build_object('requestId', p_request_id, 'releaseId', v_request.release_id, 'state', 'confirmed');
end;
$$;

create or replace function public.blog_build_active_code_slot()
returns jsonb language plpgsql security definer
set search_path = pg_catalog, blog_private, public
as $$
declare
  v_slot blog_private.build_slot%rowtype;
  v_release blog_private.releases%rowtype;
begin
  if auth.role() <> 'service_role' then raise exception 'build authority required' using errcode = '42501'; end if;
  select * into v_slot from blog_private.build_slot where singleton;
  if not found or v_slot.active_request_id is not null or v_slot.active_build_kind is distinct from 'code'
    or v_slot.active_deploy_id is null or v_slot.active_build_release_id is null then
    return jsonb_build_object('active', false);
  end if;
  select * into v_release from blog_private.releases where release_id = v_slot.active_build_release_id;
  return jsonb_build_object(
    'active', true,
    'deployId', v_slot.active_deploy_id,
    'generation', v_slot.generation,
    'releaseId', v_slot.active_build_release_id,
    'expectedDigest', v_release.digest
  );
end;
$$;

create or replace function public.blog_build_acquire(p_deploy_id text, p_hook_payload jsonb default null)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, blog_private, public
as $$
declare
  v_slot blog_private.build_slot%rowtype;
  v_request blog_private.publication_requests%rowtype;
  v_attempt blog_private.publication_dispatch_attempts%rowtype;
  v_release blog_private.releases%rowtype;
  v_code_release_id uuid;
  v_hook_request uuid;
  v_hook_release uuid;
  v_hook_attempt uuid;
begin
  if auth.role() <> 'service_role' then raise exception 'build authority required' using errcode = '42501'; end if;
  if p_deploy_id is null or p_deploy_id !~ '^[A-Za-z0-9._-]{1,128}$' then
    raise exception 'valid deploy id is required' using errcode = '22023';
  end if;
  select * into v_slot from blog_private.build_slot where singleton for update;
  if not found then raise exception 'build slot is missing' using errcode = '40001'; end if;

  if exists(select 1 from blog_private.reconciled_deploys where deploy_id = p_deploy_id) then
    raise exception 'deploy id has already been reconciled' using errcode = '40001';
  end if;

  if v_slot.active_request_id is not null then
    select * into v_request from blog_private.publication_requests where request_id = v_slot.active_request_id for update;
    if not found or v_request.publication_generation is distinct from v_slot.generation then
      raise exception 'active publication state is inconsistent' using errcode = '40001';
    end if;
    if p_hook_payload is null then
      raise exception 'editorial publication is active; code build cannot acquire slot' using errcode = '40001';
    end if;
    if jsonb_typeof(p_hook_payload) <> 'object'
      or (p_hook_payload ->> 'requestId') is null or (p_hook_payload ->> 'releaseId') is null or (p_hook_payload ->> 'attemptId') is null then
      raise exception 'hook payload is malformed' using errcode = '22023';
    end if;
    v_hook_request := (p_hook_payload ->> 'requestId')::uuid;
    v_hook_release := (p_hook_payload ->> 'releaseId')::uuid;
    v_hook_attempt := (p_hook_payload ->> 'attemptId')::uuid;

    if v_hook_request is distinct from v_request.request_id or v_hook_release is distinct from v_request.release_id then
      raise exception 'hook payload does not match reserved publication' using errcode = '40001';
    end if;
    select * into v_attempt from blog_private.publication_dispatch_attempts
    where request_id = v_request.request_id and attempt_id = v_hook_attempt and publication_generation = v_slot.generation and state <> 'failed'
    for update;
    if not found then
      raise exception 'hook attempt does not match active dispatch claim' using errcode = '40001';
    end if;
    if v_slot.active_deploy_id is not null and v_slot.active_deploy_id is distinct from p_deploy_id then
      raise exception 'build slot is already held by another deploy' using errcode = '40001';
    end if;
    if v_request.state not in ('confirmed', 'queued', 'unknown', 'building') then
      raise exception 'publication is not buildable' using errcode = '40001';
    end if;

    update blog_private.build_slot
    set active_deploy_id = p_deploy_id,
        active_build_kind = 'editorial',
        active_build_release_id = v_request.release_id,
        active_build_generation = v_slot.generation,
        active_attempt_id = v_attempt.attempt_id,
        lease_expires_at = clock_timestamp() + interval '20 minutes',
        updated_at = clock_timestamp()
    where singleton;

    update blog_private.publication_requests
    set state = 'building', updated_at = clock_timestamp()
    where request_id = v_request.request_id and state in ('confirmed', 'queued', 'unknown');

    select * into v_release from blog_private.releases where release_id = v_request.release_id;
    return jsonb_build_object(
      'releaseId', v_release.release_id,
      'payload', v_release.payload_text,
      'digest', v_release.digest,
      'generation', v_slot.generation,
      'deployId', p_deploy_id,
      'buildKind', 'editorial',
      'requestId', v_request.request_id,
      'attemptId', v_attempt.attempt_id
    );
  end if;

  if p_hook_payload is not null then
    raise exception 'no editorial publication is reserved for hook payload' using errcode = '40001';
  end if;
  if v_slot.active_deploy_id is not null and v_slot.active_deploy_id is distinct from p_deploy_id then
    raise exception 'build slot is already held by another deploy' using errcode = '40001';
  end if;
  v_code_release_id := coalesce(v_slot.last_published_release_id, v_slot.latest_confirmed_release_id);
  if v_code_release_id is null then
    raise exception 'no confirmed release is available' using errcode = '40001';
  end if;

  update blog_private.build_slot
  set active_deploy_id = p_deploy_id,
      active_build_kind = 'code',
      active_build_release_id = v_code_release_id,
      active_build_generation = v_slot.generation,
      active_attempt_id = null,
      lease_expires_at = clock_timestamp() + interval '20 minutes',
      updated_at = clock_timestamp()
  where singleton;

  select * into v_release from blog_private.releases where release_id = v_code_release_id;
  return jsonb_build_object(
    'releaseId', v_release.release_id,
    'payload', v_release.payload_text,
    'digest', v_release.digest,
    'generation', v_slot.generation,
    'deployId', p_deploy_id,
    'buildKind', 'code'
  );
end;
$$;

create or replace function public.blog_build_assert_current(p_deploy_id text, p_release_id uuid, p_generation bigint default null)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, blog_private, public
as $$
declare
  v_slot blog_private.build_slot%rowtype;
begin
  if auth.role() <> 'service_role' then raise exception 'build authority required' using errcode = '42501'; end if;
  select * into v_slot from blog_private.build_slot where singleton for share;
  if not found or v_slot.active_deploy_id is distinct from p_deploy_id
    or v_slot.active_build_release_id is distinct from p_release_id
    or (p_generation is not null and (v_slot.generation is distinct from p_generation or v_slot.active_build_generation is distinct from p_generation)) then
    raise exception 'build slot identity or release is no longer current' using errcode = '40001';
  end if;
  return jsonb_build_object('ok', true, 'deployId', p_deploy_id, 'releaseId', p_release_id, 'generation', v_slot.generation);
end;
$$;

create or replace function public.blog_build_release_code_slot(
  p_deploy_id text, p_generation bigint, p_outcome text, p_published_deploy_id text default null
) returns jsonb language plpgsql security definer
set search_path = pg_catalog, blog_private, public
as $$
declare
  v_slot blog_private.build_slot%rowtype;
begin
  if auth.role() <> 'service_role' then raise exception 'build authority required' using errcode = '42501'; end if;
  if p_outcome is null or p_outcome not in ('ready', 'failed') then raise exception 'invalid code build outcome' using errcode = '22023'; end if;
  if p_published_deploy_id is null or p_published_deploy_id !~ '^[A-Za-z0-9._-]{1,128}$' then
    raise exception 'valid published deploy id is required' using errcode = '22023';
  end if;
  if p_outcome = 'ready' and p_published_deploy_id is distinct from p_deploy_id then
    raise exception 'ready code build requires matching published deploy id' using errcode = '40001';
  end if;
  if p_outcome = 'failed' and p_published_deploy_id is not distinct from p_deploy_id then
    raise exception 'failed code build requires a different published deploy id' using errcode = '40001';
  end if;
  select * into v_slot from blog_private.build_slot where singleton for update;
  if not found or v_slot.active_build_kind is distinct from 'code' or v_slot.active_request_id is not null
    or v_slot.active_deploy_id is distinct from p_deploy_id or v_slot.generation is distinct from p_generation
    or v_slot.active_build_release_id is null then
    raise exception 'code build slot is stale' using errcode = '40001';
  end if;
  insert into blog_private.reconciled_deploys(deploy_id, build_kind, release_id, outcome)
  values(p_deploy_id, 'code', v_slot.active_build_release_id, p_outcome)
  on conflict (deploy_id) do nothing;
  update blog_private.build_slot
  set active_deploy_id = null,
      active_build_kind = null,
      active_build_release_id = null,
      active_build_generation = null,
      active_attempt_id = null,
      lease_expires_at = null,
      last_published_deploy_id = p_published_deploy_id,
      last_published_release_id = case when p_outcome = 'ready' then v_slot.active_build_release_id else last_published_release_id end,
      generation = generation + 1,
      updated_at = clock_timestamp()
  where singleton;
  return jsonb_build_object('released', true, 'deployId', p_deploy_id, 'outcome', p_outcome, 'generation', v_slot.generation + 1);
end;
$$;

create or replace function public.blog_publication_reconcile_read(
  p_user_id uuid, p_session_id uuid, p_auth_session_id uuid, p_generation bigint, p_request_id uuid
) returns jsonb language plpgsql security definer
set search_path = pg_catalog, blog_private, public, auth
as $$
declare
  v_slot blog_private.build_slot%rowtype;
  v_request blog_private.publication_requests%rowtype;
  v_release blog_private.releases%rowtype;
  v_attempt blog_private.publication_dispatch_attempts%rowtype;
begin
  if auth.role() <> 'service_role' or not blog_private.media_admin_session_live(p_user_id, p_session_id, p_generation)
    or not exists(select 1 from blog_private.admin_sessions s where s.session_id = p_session_id and s.auth_session_id = p_auth_session_id and s.user_id = p_user_id)
    or not exists(select 1 from auth.sessions a where a.id = p_auth_session_id and a.user_id = p_user_id and (a.not_after is null or a.not_after > clock_timestamp())) then
    raise exception 'editor authorization is required' using errcode = '42501';
  end if;
  select * into v_slot from blog_private.build_slot where singleton;
  select * into v_request from blog_private.publication_requests where request_id = p_request_id and owner_id = p_user_id;
  if not found then raise exception 'publication not found' using errcode = '40001'; end if;
  select * into v_release from blog_private.releases where release_id = v_request.release_id;
  select * into v_attempt from blog_private.publication_dispatch_attempts where request_id = p_request_id order by claimed_at desc limit 1;
  return jsonb_build_object(
    'requestId', v_request.request_id,
    'releaseId', v_request.release_id,
    'state', v_request.state,
    'attemptId', v_attempt.attempt_id,
    'publicationGeneration', v_request.publication_generation,
    'slotGeneration', v_slot.generation,
    'activeRequestId', v_slot.active_request_id,
    'activeDeployId', v_slot.active_deploy_id,
    'activeBuildKind', v_slot.active_build_kind,
    'activeBuildReleaseId', v_slot.active_build_release_id,
    'reconciledDeployId', (
      select rd.deploy_id from blog_private.reconciled_deploys rd
      where rd.release_id = v_request.release_id and rd.build_kind = 'editorial'
      order by rd.reconciled_at desc limit 1
    ),
    'expectedDigest', v_release.digest
  );
end;
$$;

create or replace function public.blog_publication_reconcile_commit(
  p_user_id uuid, p_session_id uuid, p_auth_session_id uuid, p_generation bigint,
  p_request_id uuid, p_publication_generation bigint, p_deploy_id text, p_outcome text, p_published_deploy_id text default null
) returns jsonb language plpgsql security definer
set search_path = pg_catalog, blog_private, public, auth
as $$
declare
  v_slot blog_private.build_slot%rowtype;
  v_request blog_private.publication_requests%rowtype;
  v_attempt blog_private.publication_dispatch_attempts%rowtype;
begin
  if auth.role() <> 'service_role' or not blog_private.media_admin_session_live(p_user_id, p_session_id, p_generation)
    or not exists(select 1 from blog_private.admin_sessions s where s.session_id = p_session_id and s.auth_session_id = p_auth_session_id and s.user_id = p_user_id)
    or not exists(select 1 from auth.sessions a where a.id = p_auth_session_id and a.user_id = p_user_id and (a.not_after is null or a.not_after > clock_timestamp())) then
    raise exception 'editor authorization is required' using errcode = '42501';
  end if;
  if p_outcome is null or p_outcome not in ('building', 'live', 'failed') then
    raise exception 'invalid reconcile outcome' using errcode = '22023';
  end if;
  if p_outcome in ('live', 'failed') and (p_published_deploy_id is null or p_published_deploy_id !~ '^[A-Za-z0-9._-]{1,128}$') then
    raise exception 'valid published deploy id is required' using errcode = '22023';
  end if;
  if p_outcome = 'live' and p_published_deploy_id is distinct from p_deploy_id then
    raise exception 'live outcome requires matching published deploy id' using errcode = '40001';
  end if;
  if p_outcome = 'failed' and p_published_deploy_id is not distinct from p_deploy_id then
    raise exception 'failed outcome requires a different published deploy id' using errcode = '40001';
  end if;

  select * into v_slot from blog_private.build_slot where singleton for update;
  if not blog_private.media_admin_session_live(p_user_id, p_session_id, p_generation) then
    raise exception 'editor authorization is required' using errcode = '42501';
  end if;
  select * into v_request from blog_private.publication_requests where request_id = p_request_id and owner_id = p_user_id for update;
  if not found or v_slot.active_request_id is distinct from p_request_id
    or v_slot.generation is distinct from p_publication_generation
    or v_request.publication_generation is distinct from p_publication_generation
    or v_slot.active_deploy_id is distinct from p_deploy_id
    or v_slot.active_build_kind is distinct from 'editorial'
    or v_slot.active_build_release_id is distinct from v_request.release_id
    or v_slot.active_attempt_id is null
    or v_request.state not in ('confirmed', 'queued', 'unknown', 'building') then
    raise exception 'stale reconciliation callback' using errcode = '40001';
  end if;

  select * into v_attempt from blog_private.publication_dispatch_attempts
  where request_id = p_request_id and attempt_id = v_slot.active_attempt_id and publication_generation = p_publication_generation and state <> 'failed'
  for update;
  if not found then
    raise exception 'stale reconciliation attempt' using errcode = '40001';
  end if;

  if p_outcome = 'building' then
    update blog_private.publication_requests set state = 'building', updated_at = clock_timestamp()
    where request_id = p_request_id and state in ('confirmed', 'queued', 'unknown');
    return jsonb_build_object('requestId', p_request_id, 'releaseId', v_request.release_id, 'state', 'building', 'deployId', p_deploy_id);
  end if;

  insert into blog_private.reconciled_deploys(deploy_id, build_kind, release_id, outcome)
  values(p_deploy_id, 'editorial', v_request.release_id, p_outcome)
  on conflict (deploy_id) do nothing;

  if p_outcome = 'live' then
    update blog_private.publication_requests set state = 'live', updated_at = clock_timestamp() where request_id = p_request_id;
    update blog_private.build_slot
    set latest_confirmed_release_id = v_request.release_id,
        last_published_release_id = v_request.release_id,
        active_request_id = null,
        active_deploy_id = null,
        active_build_kind = null,
        active_build_release_id = null,
        active_build_generation = null,
        active_attempt_id = null,
        lease_expires_at = null,
        last_published_deploy_id = p_published_deploy_id,
        generation = generation + 1,
        updated_at = clock_timestamp()
    where singleton;
    return jsonb_build_object('requestId', p_request_id, 'releaseId', v_request.release_id, 'state', 'live', 'deployId', p_deploy_id);
  end if;

  -- Keep editorial reservation on proven failure; clear build identity and advance generation together.
  update blog_private.publication_requests
  set state = 'failed',
      publication_generation = v_slot.generation + 1,
      updated_at = clock_timestamp()
  where request_id = p_request_id;
  update blog_private.publication_dispatch_attempts
  set state = 'failed', updated_at = clock_timestamp()
  where request_id = p_request_id and attempt_id = v_slot.active_attempt_id;
  update blog_private.build_slot
  set active_deploy_id = null,
      active_build_kind = null,
      active_build_release_id = null,
      active_build_generation = null,
      active_attempt_id = null,
      lease_expires_at = null,
      last_published_deploy_id = p_published_deploy_id,
      last_published_release_id = case when p_outcome = 'ready' then v_slot.active_build_release_id else last_published_release_id end,
      generation = generation + 1,
      updated_at = clock_timestamp()
  where singleton;
  return jsonb_build_object('requestId', p_request_id, 'releaseId', v_request.release_id, 'state', 'failed', 'deployId', p_deploy_id);
end;
$$;

revoke execute on function public.blog_build_active_code_slot() from public, anon, authenticated;
revoke execute on function public.blog_build_acquire(text, jsonb) from public, anon, authenticated;
revoke execute on function public.blog_build_assert_current(text, uuid, bigint) from public, anon, authenticated;
revoke execute on function public.blog_build_release_code_slot(text, bigint, text, text) from public, anon, authenticated;
revoke execute on function public.blog_publication_reconcile_read(uuid, uuid, uuid, bigint, uuid) from public, anon, authenticated;
revoke execute on function public.blog_publication_reconcile_commit(uuid, uuid, uuid, bigint, uuid, bigint, text, text, text) from public, anon, authenticated;

grant execute on function public.blog_build_active_code_slot() to service_role;
grant execute on function public.blog_build_acquire(text, jsonb) to service_role;
grant execute on function public.blog_build_assert_current(text, uuid, bigint) to service_role;
grant execute on function public.blog_build_release_code_slot(text, bigint, text, text) to service_role;
grant execute on function public.blog_publication_reconcile_read(uuid, uuid, uuid, bigint, uuid) to service_role;
grant execute on function public.blog_publication_reconcile_commit(uuid, uuid, uuid, bigint, uuid, bigint, text, text, text) to service_role;
