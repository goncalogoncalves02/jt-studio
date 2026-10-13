begin;

do $task7_publication_dispatch$
declare
  v_owner uuid := gen_random_uuid();
  v_provider_session uuid := gen_random_uuid();
  v_app_session uuid := gen_random_uuid();
  v_post uuid;
  v_request uuid := gen_random_uuid();
  v_other_request uuid := gen_random_uuid();
  v_attempt uuid := gen_random_uuid();
  v_summary jsonb;
  v_release jsonb;
  v_replay jsonb;
  v_claim jsonb;
  v_status jsonb;
  v_base_release uuid;
  v_base_posts jsonb;
  v_error boolean := false;
begin
  raise notice 'task7-stage:base';
  select b.latest_confirmed_release_id, r.payload_text::jsonb -> 'posts'
    into v_base_release, v_base_posts
  from blog_private.build_slot b
  join blog_private.releases r on r.release_id=b.latest_confirmed_release_id
  where b.singleton;
  if v_base_release is null then raise exception 'task7 requires an existing confirmed base'; end if;

  update blog_private.settings set authorized_owner_id=v_owner where singleton and authorized_owner_id is null;
  if not found then raise exception 'task7 requires owner NULL baseline'; end if;
  insert into auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
  values(v_owner,'authenticated','authenticated','task7-'||v_owner||'@example.invalid','',clock_timestamp(),'{}'::jsonb,'{}'::jsonb,clock_timestamp(),clock_timestamp());
  insert into auth.sessions(id,user_id,created_at,updated_at,not_after)
  values(v_provider_session,v_owner,clock_timestamp(),clock_timestamp(),null);
  insert into blog_private.admin_sessions(session_id,user_id,auth_session_id,generation,cookie_digest,expires_at,auth_expires_at,token_ciphertext)
  values(v_app_session,v_owner,v_provider_session,1,extensions.digest(v_app_session::text,'sha256'),clock_timestamp()+interval '10 minutes',clock_timestamp()+interval '10 minutes','v1.a.a.a');
  perform set_config('request.jwt.claim.sub',v_owner::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_owner,'session_id',v_provider_session,'exp',floor(extract(epoch from clock_timestamp()))::bigint+600)::text,true);
  set local role authenticated;

  raise notice 'task7-stage:save';
  v_post := (public.blog_save_post(jsonb_build_object(
    'title','Task 7 retained and ready','slug','task7-'||replace(v_owner::text,'-',''),
    'excerpt','Approved test fixture','document','{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Task 7 frozen content"}]}]}'::jsonb,
    'coverMediaId',null,'serviceId',null),0,v_app_session,1)->>'id')::uuid;
  perform public.blog_mark_prepared(v_post,1,'upsert',v_app_session,1);
  v_summary := public.blog_publication_summary(v_app_session,1);
  reset role;
  update auth.sessions set not_after=clock_timestamp()-interval '1 second' where id=v_provider_session;
  set local role authenticated;
  begin
    perform public.blog_publication_summary(v_app_session,1);
  exception when sqlstate '42501' then v_error := true;
  end;
  if not v_error then raise exception 'RED publication summary accepted an expired provider session' using errcode='P0001'; end if;
  reset role;
  update auth.sessions set not_after=null where id=v_provider_session;
  set local role authenticated;
  v_summary := public.blog_publication_summary(v_app_session,1);

  raise notice 'task7-stage:confirm';
  -- Preserve compatibility with the existing authenticated confirmation RPC while proving it reserves the slot.
  v_release := public.blog_freeze_release(v_request,1,v_app_session,v_summary->>'digest');
  raise notice 'task7-stage:frozen';
  if (v_release->>'releaseId') is null or (v_release->>'digest') !~ '^[a-f0-9]{64}$'
    or encode(extensions.digest(convert_to(v_release->>'payload','UTF8'),'sha256'),'hex') <> v_release->>'digest'
    or not ((v_release->>'payload')::jsonb->'posts' @> v_base_posts)
    or not exists(select 1 from jsonb_array_elements((v_release->>'payload')::jsonb->'posts') p where p->>'id'=v_post::text) then
    raise exception 'confirmation must freeze the exact complete set and preserve the base';
  end if;
  reset role;
  if not exists(select 1 from blog_private.build_slot where singleton and active_request_id=v_request)
    or not exists(select 1 from blog_private.publication_requests where request_id=v_request and state='confirmed') then
    raise exception 'legacy confirmation did not reserve the active publication';
  end if;
  set local role authenticated;
  v_replay := public.blog_freeze_release(v_request,1,v_app_session,v_summary->>'digest');
  raise notice 'task7-stage:replayed';
  if v_replay->>'releaseId' is distinct from v_release->>'releaseId'
    or v_replay->>'payload' is distinct from v_release->>'payload' then
    raise exception 'same request and digest must return the exact immutable snapshot';
  end if;
  reset role;

  v_error := false;
  begin
    perform public.blog_freeze_release(v_other_request,1,v_app_session,v_summary->>'digest');
  exception when sqlstate '40001' then v_error := true;
  end;
  if not v_error or exists(select 1 from blog_private.publication_requests where request_id=v_other_request) then
    raise exception 'a second request must fail while the first request is active';
  end if;

  reset role;
  set local role service_role;
  raise notice 'task7-stage:claim';
  v_claim := public.blog_publication_dispatch_claim(v_owner,v_app_session,v_provider_session,1,v_request,v_attempt);
  raise notice 'task7-stage:claimed';
  if (v_claim->>'claimed')::boolean is not true or v_claim->>'releaseId' is distinct from v_release->>'releaseId' then
    raise exception 'first dispatch claimant must reserve exactly the confirmed release';
  end if;
  v_status := public.blog_publication_dispatch_claim(v_owner,v_app_session,v_provider_session,1,v_request,gen_random_uuid());
  raise notice 'task7-stage:claim-replay';
  if (v_status->>'claimed')::boolean is distinct from false or v_status->'status'->>'state' is distinct from 'unknown' then
    raise exception 'a repeated claim during an in-flight request must project unknown without another claim';
  end if;
  v_status := public.blog_publication_dispatch_result(v_owner,v_app_session,v_provider_session,1,v_request,v_attempt,'unknown');
  raise notice 'task7-stage:result';
  if v_status->>'state' is distinct from 'unknown' then raise exception 'ambiguous hook outcome must remain unknown'; end if;

  v_error := false;
  begin
    perform public.blog_publication_retry(v_owner,v_app_session,v_provider_session,1,v_request,gen_random_uuid());
  exception when sqlstate '40001' then v_error := true;
  end;
  if not v_error then raise exception 'unknown dispatch outcome must not be retried'; end if;
end;
$task7_publication_dispatch$;

rollback;
