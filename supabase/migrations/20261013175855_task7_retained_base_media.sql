create or replace function blog_private.publication_variant_was_in_base(p_request_id uuid,p_media_id text,p_width integer)
returns boolean language sql stable security definer set search_path=pg_catalog,blog_private
as $$
  select exists(
    select 1 from blog_private.publication_requests request
    join blog_private.releases release on release.release_id=request.release_id
    cross join lateral jsonb_array_elements(blog_private.v_payload_json(release.base_release_id)->'posts') post
    cross join lateral jsonb_array_elements(coalesce(post->'media','[]'::jsonb)||case when post->'coverMedia' is null or post->'coverMedia'='null'::jsonb then '[]'::jsonb else jsonb_build_array(post->'coverMedia') end) media
    cross join lateral jsonb_array_elements(coalesce(media->'variants','[]'::jsonb)) variant
    where request.request_id=p_request_id and media->>'id'=p_media_id and (variant->>'width')::integer=p_width
  )
$$;
revoke all on function blog_private.publication_variant_was_in_base(uuid,text,integer) from public,anon,authenticated,service_role;

create table blog_private.publication_retry_receipts (
  request_id uuid not null references blog_private.publication_requests(request_id) on delete restrict,
  retry_id uuid not null,
  publication_generation bigint not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key(request_id,retry_id)
);
revoke all on blog_private.publication_retry_receipts from public,anon,authenticated,service_role;

create or replace function public.blog_publication_dispatch_claim(
  p_user_id uuid,p_session_id uuid,p_auth_session_id uuid,p_generation bigint,p_request_id uuid,p_attempt_id uuid
) returns jsonb language plpgsql security definer
set search_path=pg_catalog,blog_private,public,auth
as $$
declare v_request blog_private.publication_requests%rowtype; v_active uuid; v_generation bigint; v_previous blog_private.publication_dispatch_attempts%rowtype;
begin
  if auth.role()<>'service_role' or p_attempt_id is null then raise exception 'publication authority required' using errcode='42501'; end if;
  if not blog_private.media_admin_session_live(p_user_id,p_session_id,p_generation)
    or not exists(select 1 from blog_private.admin_sessions s where s.session_id=p_session_id and s.user_id=p_user_id and s.auth_session_id=p_auth_session_id)
    or not exists(select 1 from auth.sessions a where a.id=p_auth_session_id and a.user_id=p_user_id and (a.not_after is null or a.not_after>clock_timestamp())) then raise exception 'editor authorization is required' using errcode='42501'; end if;
  perform 1 from blog_private.build_slot where singleton for update;
  if not blog_private.media_admin_session_live(p_user_id,p_session_id,p_generation) then raise exception 'editor authorization is required' using errcode='42501'; end if;
  select active_request_id,generation into v_active,v_generation from blog_private.build_slot where singleton;
  select * into v_request from blog_private.publication_requests where request_id=p_request_id and owner_id=p_user_id for update;
  if not found or v_active is distinct from p_request_id or v_request.publication_generation is distinct from v_generation then raise exception 'publication is not active' using errcode='40001'; end if;
  select * into v_previous from blog_private.publication_dispatch_attempts where request_id=p_request_id order by claimed_at limit 1;
  if found then return jsonb_build_object('claimed',false,'status',jsonb_build_object('requestId',p_request_id,'releaseId',v_request.release_id,'state',case when v_previous.state='queued' then 'queued' else 'unknown' end,'attemptId',v_previous.attempt_id)); end if;
  if v_request.state<>'confirmed' or exists(
    select 1 from jsonb_array_elements(blog_private.v_payload_json(v_request.release_id)->'posts') post
    cross join lateral jsonb_array_elements(coalesce(post->'media','[]'::jsonb)||case when post->'coverMedia' is null or post->'coverMedia'='null'::jsonb then '[]'::jsonb else jsonb_build_array(post->'coverMedia') end) media
    cross join lateral jsonb_array_elements(coalesce(media->'variants','[]'::jsonb)) variant
    left join blog_private.publication_variant_progress progress on progress.request_id=p_request_id and progress.media_id=media->>'id' and progress.width=(variant->>'width')::integer
    where progress.request_id is null and not blog_private.publication_variant_was_in_base(p_request_id,media->>'id',(variant->>'width')::integer)
  ) then raise exception 'publication media promotion is incomplete' using errcode='40001'; end if;
  insert into blog_private.publication_dispatch_attempts(request_id,attempt_id,publication_generation,state) values(p_request_id,p_attempt_id,v_generation,'claimed');
  return jsonb_build_object('claimed',true,'requestId',p_request_id,'releaseId',v_request.release_id,'attemptId',p_attempt_id,'generation',v_generation);
end;
$$;

create or replace function public.blog_publication_next_variant(p_user_id uuid,p_session_id uuid,p_auth_session_id uuid,p_generation bigint,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,blog_private,public,auth
as $$
declare v_request blog_private.publication_requests%rowtype; v_item record; v_active uuid; v_gen bigint;
begin
  if auth.role()<>'service_role' or not blog_private.media_admin_session_live(p_user_id,p_session_id,p_generation)
    or not exists(select 1 from blog_private.admin_sessions s where s.session_id=p_session_id and s.auth_session_id=p_auth_session_id and s.user_id=p_user_id) then raise exception 'editor authorization is required' using errcode='42501'; end if;
  perform 1 from blog_private.build_slot where singleton for update;
  if not blog_private.media_admin_session_live(p_user_id,p_session_id,p_generation) then raise exception 'editor authorization is required' using errcode='42501'; end if;
  select active_request_id,generation into v_active,v_gen from blog_private.build_slot where singleton;
  select * into v_request from blog_private.publication_requests where request_id=p_request_id and owner_id=p_user_id for update;
  if not found or v_active is distinct from p_request_id or v_request.publication_generation is distinct from v_gen then raise exception 'publication is stale' using errcode='40001'; end if;
  select media.value->>'id' as media_id,(variant.value->>'width')::integer as width into v_item
  from jsonb_array_elements(blog_private.v_payload_json(v_request.release_id)->'posts') post
  cross join lateral jsonb_array_elements(coalesce(post->'media','[]'::jsonb)||case when post->'coverMedia' is null or post->'coverMedia'='null'::jsonb then '[]'::jsonb else jsonb_build_array(post->'coverMedia') end) media
  cross join lateral jsonb_array_elements(coalesce(media.value->'variants','[]'::jsonb)) variant
  left join blog_private.publication_variant_progress progress on progress.request_id=p_request_id and progress.media_id=media.value->>'id' and progress.width=(variant.value->>'width')::integer
  where progress.request_id is null and not blog_private.publication_variant_was_in_base(p_request_id,media.value->>'id',(variant.value->>'width')::integer)
  order by media.value->>'id',(variant.value->>'width')::integer limit 1;
  if v_item.media_id is null then return jsonb_build_object('complete',true,'status',jsonb_build_object('requestId',p_request_id,'releaseId',v_request.release_id,'state',v_request.state)); end if;
  return jsonb_build_object('complete',false,'requestId',p_request_id,'releaseId',v_request.release_id,'mediaId',v_item.media_id,'width',v_item.width);
end;
$$;

create or replace function public.blog_publication_variant_manifest(p_user_id uuid,p_session_id uuid,p_auth_session_id uuid,p_generation bigint,p_request_id uuid,p_media_id text,p_width integer)
returns jsonb language plpgsql security definer set search_path=pg_catalog,blog_private,public,auth
as $$
declare v_request blog_private.publication_requests%rowtype; v_variant jsonb; v_media jsonb; v_active uuid; v_slot_generation bigint;
begin
  if auth.role()<>'service_role' or not blog_private.media_admin_session_live(p_user_id,p_session_id,p_generation)
    or not exists(select 1 from blog_private.admin_sessions s where s.session_id=p_session_id and s.auth_session_id=p_auth_session_id and s.user_id=p_user_id) then raise exception 'editor authorization is required' using errcode='42501'; end if;
  perform 1 from blog_private.build_slot where singleton for update;
  if not blog_private.media_admin_session_live(p_user_id,p_session_id,p_generation) then raise exception 'editor authorization is required' using errcode='42501'; end if;
  select active_request_id,generation into v_active,v_slot_generation from blog_private.build_slot where singleton;
  select * into v_request from blog_private.publication_requests where request_id=p_request_id and owner_id=p_user_id for update;
  if not found or v_active is distinct from p_request_id or v_request.publication_generation is distinct from v_slot_generation then raise exception 'publication is stale' using errcode='40001'; end if;
  select media.value into v_media from jsonb_array_elements(blog_private.v_payload_json(v_request.release_id)->'posts') post
  cross join lateral jsonb_array_elements(coalesce(post->'media','[]'::jsonb)||case when post->'coverMedia' is null or post->'coverMedia'='null'::jsonb then '[]'::jsonb else jsonb_build_array(post->'coverMedia') end) media
  where media.value->>'id'=p_media_id limit 1;
  select value into v_variant from jsonb_array_elements(coalesce(v_media->'variants','[]'::jsonb)) where (value->>'width')::integer=p_width;
  if v_variant is null or v_variant->>'mime'<>'image/webp' then raise exception 'variant not in confirmed snapshot' using errcode='42501'; end if;
  return jsonb_build_object('requestId',p_request_id,'releaseId',v_request.release_id,'ownerId',p_user_id,'mediaId',p_media_id,
    'width',(v_variant->>'width')::integer,'height',(v_variant->>'height')::integer,'mime',v_variant->>'mime',
    'byteLength',(v_variant->>'byteLength')::integer,'sha256',v_variant->>'sha256','objectKey',v_variant->>'objectKey');
end;
$$;

create or replace function public.blog_publication_record_variant(p_user_id uuid,p_session_id uuid,p_auth_session_id uuid,p_generation bigint,p_request_id uuid,p_media_id text,p_width integer,p_object_key text,p_sha256 text,p_byte_length integer)
returns jsonb language plpgsql security definer set search_path=pg_catalog,blog_private,public,auth
as $$
declare v_manifest jsonb; v_request blog_private.publication_requests%rowtype;
begin
  v_manifest:=public.blog_publication_variant_manifest(p_user_id,p_session_id,p_auth_session_id,p_generation,p_request_id,p_media_id,p_width);
  if v_manifest->>'objectKey' is distinct from p_object_key or v_manifest->>'sha256' is distinct from p_sha256 or (v_manifest->>'byteLength')::integer is distinct from p_byte_length then raise exception 'verified object does not match snapshot' using errcode='23514'; end if;
  select * into v_request from blog_private.publication_requests where request_id=p_request_id and owner_id=p_user_id for update;
  insert into blog_private.publication_variant_progress(request_id,release_id,publication_generation,media_id,width,object_key,sha256,byte_length)
  values(p_request_id,v_request.release_id,v_request.publication_generation,p_media_id,p_width,p_object_key,p_sha256,p_byte_length) on conflict(request_id,media_id,width) do nothing;
  if not exists(select 1 from blog_private.publication_variant_progress p where p.request_id=p_request_id and p.media_id=p_media_id and p.width=p_width and p.release_id=v_request.release_id and p.publication_generation=v_request.publication_generation and p.sha256=p_sha256 and p.byte_length=p_byte_length) then raise exception 'variant receipt conflicts with immutable progress' using errcode='23505'; end if;
  return jsonb_build_object('requestId',p_request_id,'releaseId',v_request.release_id,'state','promoting');
end;
$$;

create or replace function public.blog_publication_dispatch_result(p_user_id uuid,p_session_id uuid,p_auth_session_id uuid,p_generation bigint,p_request_id uuid,p_attempt_id uuid,p_state text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,blog_private,public,auth
as $$
declare v_request blog_private.publication_requests%rowtype; v_attempt blog_private.publication_dispatch_attempts%rowtype; v_active uuid; v_slot_generation bigint;
begin
  if auth.role()<>'service_role' or p_state not in ('queued','unknown') then raise exception 'publication authority required' using errcode='42501'; end if;
  if not blog_private.media_admin_session_live(p_user_id,p_session_id,p_generation)
    or not exists(select 1 from blog_private.admin_sessions s where s.session_id=p_session_id and s.user_id=p_user_id and s.auth_session_id=p_auth_session_id)
    or not exists(select 1 from auth.sessions a where a.id=p_auth_session_id and a.user_id=p_user_id and (a.not_after is null or a.not_after>clock_timestamp())) then raise exception 'editor authorization is required' using errcode='42501'; end if;
  perform 1 from blog_private.build_slot where singleton for update;
  if not blog_private.media_admin_session_live(p_user_id,p_session_id,p_generation) then raise exception 'editor authorization is required' using errcode='42501'; end if;
  select active_request_id,generation into v_active,v_slot_generation from blog_private.build_slot where singleton;
  select * into v_request from blog_private.publication_requests where request_id=p_request_id and owner_id=p_user_id for update;
  if not found or v_active is distinct from p_request_id or v_slot_generation is distinct from v_request.publication_generation then raise exception 'publication attempt is stale' using errcode='40001'; end if;
  select * into v_attempt from blog_private.publication_dispatch_attempts where request_id=p_request_id and attempt_id=p_attempt_id for update;
  if not found or v_attempt.publication_generation is distinct from v_request.publication_generation then raise exception 'publication attempt is stale' using errcode='40001'; end if;
  if v_attempt.state in ('queued','unknown') then return jsonb_build_object('requestId',p_request_id,'releaseId',v_request.release_id,'attemptId',p_attempt_id,'state',v_attempt.state); end if;
  update blog_private.publication_dispatch_attempts set state=p_state,updated_at=clock_timestamp() where request_id=p_request_id and attempt_id=p_attempt_id;
  update blog_private.publication_requests set state=p_state,updated_at=clock_timestamp() where request_id=p_request_id;
  return jsonb_build_object('requestId',p_request_id,'releaseId',v_request.release_id,'attemptId',p_attempt_id,'state',p_state);
end;
$$;

create or replace function public.blog_publication_status(p_user_id uuid,p_session_id uuid,p_auth_session_id uuid,p_generation bigint,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,blog_private,public,auth
as $$
declare v_request blog_private.publication_requests%rowtype; v_attempt blog_private.publication_dispatch_attempts%rowtype; v_state text; v_active uuid; v_slot_generation bigint;
begin
  if auth.role()<>'service_role' or not blog_private.media_admin_session_live(p_user_id,p_session_id,p_generation)
    or not exists(select 1 from blog_private.admin_sessions s where s.session_id=p_session_id and s.auth_session_id=p_auth_session_id and s.user_id=p_user_id)
    or not exists(select 1 from auth.sessions a where a.id=p_auth_session_id and a.user_id=p_user_id and (a.not_after is null or a.not_after>clock_timestamp())) then raise exception 'editor authorization is required' using errcode='42501'; end if;
  perform 1 from blog_private.build_slot where singleton for update;
  if not blog_private.media_admin_session_live(p_user_id,p_session_id,p_generation) then raise exception 'editor authorization is required' using errcode='42501'; end if;
  select active_request_id,generation into v_active,v_slot_generation from blog_private.build_slot where singleton;
  select * into v_request from blog_private.publication_requests where request_id=p_request_id and owner_id=p_user_id;
  if not found or v_active is distinct from p_request_id or v_request.publication_generation is distinct from v_slot_generation then raise exception 'publication is stale' using errcode='40001'; end if;
  select * into v_attempt from blog_private.publication_dispatch_attempts where request_id=p_request_id order by claimed_at limit 1;
  if found then v_state:=case when v_attempt.state='queued' then 'queued' else 'unknown' end;
  elsif v_request.state='confirmed' and exists(select 1 from blog_private.publication_variant_progress p where p.request_id=p_request_id) then v_state:='promoting';
  else v_state:=v_request.state; end if;
  return jsonb_build_object('requestId',p_request_id,'releaseId',v_request.release_id,'state',v_state,
    'attemptId',case when v_attempt.attempt_id is null then null else v_attempt.attempt_id end);
end;
$$;

create or replace function public.blog_publication_retry(p_user_id uuid,p_session_id uuid,p_auth_session_id uuid,p_generation bigint,p_request_id uuid,p_retry_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,blog_private,public,auth
as $$
declare v_request blog_private.publication_requests%rowtype; v_active uuid; v_slot_generation bigint;
begin
  if auth.role()<>'service_role' or not blog_private.media_admin_session_live(p_user_id,p_session_id,p_generation)
    or not exists(select 1 from blog_private.admin_sessions s where s.session_id=p_session_id and s.user_id=p_user_id and s.auth_session_id=p_auth_session_id)
    or not exists(select 1 from auth.sessions a where a.id=p_auth_session_id and a.user_id=p_user_id and (a.not_after is null or a.not_after>clock_timestamp())) then raise exception 'editor authorization is required' using errcode='42501'; end if;
  perform 1 from blog_private.build_slot where singleton for update;
  if not blog_private.media_admin_session_live(p_user_id,p_session_id,p_generation) then raise exception 'editor authorization is required' using errcode='42501'; end if;
  select active_request_id,generation into v_active,v_slot_generation from blog_private.build_slot where singleton;
  select * into v_request from blog_private.publication_requests where request_id=p_request_id and owner_id=p_user_id for update;
  if not found or v_active is distinct from p_request_id or v_slot_generation is distinct from v_request.publication_generation then raise exception 'publication is stale' using errcode='40001'; end if;
  if exists(select 1 from blog_private.publication_retry_receipts where request_id=p_request_id and retry_id=p_retry_id) then
    return jsonb_build_object('requestId',p_request_id,'releaseId',v_request.release_id,'state',v_request.state);
  end if;
  if v_request.state<>'failed' or exists(select 1 from blog_private.publication_dispatch_attempts where request_id=p_request_id) then raise exception 'only a proven no-dispatch failure can be retried' using errcode='40001'; end if;
  insert into blog_private.publication_retry_receipts(request_id,retry_id,publication_generation) values(p_request_id,p_retry_id,v_request.publication_generation);
  update blog_private.publication_requests set state='confirmed',updated_at=clock_timestamp() where request_id=p_request_id;
  return jsonb_build_object('requestId',p_request_id,'releaseId',v_request.release_id,'state','confirmed');
end;
$$;

create or replace function public.blog_publication_mark_pre_dispatch_failed(p_user_id uuid,p_session_id uuid,p_auth_session_id uuid,p_generation bigint,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,blog_private,public,auth
as $$
declare v_request blog_private.publication_requests%rowtype; v_active uuid; v_slot_generation bigint;
begin
  if auth.role()<>'service_role' or not blog_private.media_admin_session_live(p_user_id,p_session_id,p_generation)
    or not exists(select 1 from blog_private.admin_sessions s where s.session_id=p_session_id and s.user_id=p_user_id and s.auth_session_id=p_auth_session_id)
    or not exists(select 1 from auth.sessions a where a.id=p_auth_session_id and a.user_id=p_user_id and (a.not_after is null or a.not_after>clock_timestamp())) then raise exception 'editor authorization is required' using errcode='42501'; end if;
  perform 1 from blog_private.build_slot where singleton for update;
  if not blog_private.media_admin_session_live(p_user_id,p_session_id,p_generation) then raise exception 'editor authorization is required' using errcode='42501'; end if;
  select active_request_id,generation into v_active,v_slot_generation from blog_private.build_slot where singleton;
  select * into v_request from blog_private.publication_requests where request_id=p_request_id and owner_id=p_user_id for update;
  if not found or v_active is distinct from p_request_id or v_slot_generation is distinct from v_request.publication_generation then raise exception 'publication is stale' using errcode='40001'; end if;
  if exists(select 1 from blog_private.publication_dispatch_attempts where request_id=p_request_id) then raise exception 'dispatch outcome is already claimed' using errcode='40001'; end if;
  update blog_private.publication_requests set state='failed',updated_at=clock_timestamp() where request_id=p_request_id and state='confirmed';
  return jsonb_build_object('requestId',p_request_id,'releaseId',v_request.release_id,'state','failed');
end;
$$;

revoke execute on function public.blog_publication_status(uuid,uuid,uuid,bigint,uuid) from public,anon,authenticated;
revoke execute on function public.blog_publication_retry(uuid,uuid,uuid,bigint,uuid,uuid) from public,anon,authenticated;
revoke execute on function public.blog_publication_mark_pre_dispatch_failed(uuid,uuid,uuid,bigint,uuid) from public,anon,authenticated;
grant execute on function public.blog_publication_status(uuid,uuid,uuid,bigint,uuid) to service_role;
grant execute on function public.blog_publication_retry(uuid,uuid,uuid,bigint,uuid,uuid) to service_role;
grant execute on function public.blog_publication_mark_pre_dispatch_failed(uuid,uuid,uuid,bigint,uuid) to service_role;
