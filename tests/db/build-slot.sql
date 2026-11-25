begin;

do $task8_build_slot$
declare
  v_owner uuid := gen_random_uuid();
  v_provider_session uuid := gen_random_uuid();
  v_app_session uuid := gen_random_uuid();
  v_post uuid;
  v_old_failed_request uuid := gen_random_uuid();
  v_old_failed_release uuid := gen_random_uuid();
  v_request uuid := gen_random_uuid();
  v_attempt uuid := gen_random_uuid();
  v_retry_attempt uuid := gen_random_uuid();
  v_retry_id uuid := gen_random_uuid();
  v_base_release uuid;
  v_summary jsonb;
  v_release jsonb;
  v_release_id uuid;
  v_gen_code bigint;
  v_gen_editorial bigint;
  v_active_code jsonb;
  v_acquired jsonb;
  v_status jsonb;
  v_error boolean := false;
begin
  select latest_confirmed_release_id into v_base_release
  from blog_private.build_slot where singleton;
  if v_base_release is null then raise exception 'task8 requires an existing confirmed base release'; end if;

  if exists (
    select 1
    from unnest(array[
      'public.blog_build_active_code_slot()',
      'public.blog_build_acquire(text,jsonb)',
      'public.blog_build_assert_current(text,uuid,bigint)',
      'public.blog_build_release_code_slot(text,bigint,text,text)',
      'public.blog_publication_reconcile_read(uuid,uuid,uuid,bigint,uuid)',
      'public.blog_publication_current(uuid,uuid,uuid,bigint)',
      'public.blog_publication_reconcile_commit(uuid,uuid,uuid,bigint,uuid,bigint,text,text,text)'
    ]) as rpc(signature)
    where has_function_privilege('anon', signature, 'EXECUTE')
      or has_function_privilege('authenticated', signature, 'EXECUTE')
      or not has_function_privilege('service_role', signature, 'EXECUTE')
  ) then raise exception 'build reconciliation RPCs must be service-role only'; end if;

  update blog_private.settings set authorized_owner_id = v_owner where singleton and authorized_owner_id is null;
  if not found then raise exception 'task8 requires owner NULL baseline'; end if;
  insert into auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
  values(v_owner,'authenticated','authenticated','task8-'||v_owner||'@example.invalid','',clock_timestamp(),'{}'::jsonb,'{}'::jsonb,clock_timestamp(),clock_timestamp());
  insert into auth.sessions(id,user_id,created_at,updated_at,not_after)
  values(v_provider_session,v_owner,clock_timestamp(),clock_timestamp(),null);
  insert into blog_private.admin_sessions(session_id,user_id,auth_session_id,generation,cookie_digest,expires_at,auth_expires_at,token_ciphertext)
  values(v_app_session,v_owner,v_provider_session,1,extensions.digest(v_app_session::text,'sha256'),clock_timestamp()+interval '10 minutes',clock_timestamp()+interval '10 minutes','v1.a.a.a');

  -- Historical inactive failed release/request must never be retried after newer content exists.
  insert into blog_private.releases(release_id, base_release_id, payload_text, digest)
  values(v_old_failed_release, v_base_release, jsonb_build_object('schemaVersion',1,'releaseId',v_old_failed_release,'posts','[]'::jsonb)::text, encode(extensions.digest(convert_to(jsonb_build_object('schemaVersion',1,'releaseId',v_old_failed_release,'posts','[]'::jsonb)::text,'UTF8'),'sha256'),'hex'));
  insert into blog_private.publication_requests(request_id, owner_id, release_id, expected_summary_digest, state, publication_generation)
  values(v_old_failed_request, v_owner, v_old_failed_release, repeat('a', 64), 'failed', 0);

  -- 1. Code build A acquires the slot first.
  set local role service_role;
  v_acquired := public.blog_build_acquire('deploy-code-a', null);
  v_gen_code := (v_acquired->>'generation')::bigint;
  if (v_acquired->>'releaseId')::uuid is distinct from v_base_release or v_acquired->>'buildKind' <> 'code' then
    raise exception 'code build A did not acquire base release';
  end if;

  v_active_code := public.blog_build_active_code_slot();
  if (v_active_code->>'active')::boolean is not true or v_active_code->>'deployId' <> 'deploy-code-a' then
    raise exception 'active code slot read did not report code build A';
  end if;

  -- Another deploy cannot acquire while code build A holds the slot.
  v_error := false;
  begin
    perform public.blog_build_acquire('deploy-code-other', null);
  exception when sqlstate '40001' then v_error := true;
  end;
  if not v_error then raise exception 'concurrent code build acquired held slot'; end if;

  -- Editorial confirmation B cannot move requestedRelease while code build A holds the slot.
  reset role;
  perform set_config('request.jwt.claim.sub', v_owner::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_owner, 'session_id', v_provider_session, 'exp', floor(extract(epoch from clock_timestamp()))::bigint + 600)::text, true);
  set local role authenticated;
  v_post := (public.blog_save_post(jsonb_build_object(
    'title','Task 8 post','slug','task8-'||replace(v_owner::text,'-',''),
    'excerpt','Task 8 excerpt','document','{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Task 8 body"}]}]}'::jsonb,
    'coverMediaId',null,'serviceId',null),0,v_app_session,1)->>'id')::uuid;
  perform public.blog_mark_prepared(v_post, 1, 'upsert', v_app_session, 1);
  v_summary := public.blog_publication_summary(v_app_session, 1);

  v_error := false;
  begin
    perform public.blog_freeze_release(v_request, 1, v_app_session, v_summary->>'digest');
  exception when sqlstate '40001' then v_error := true;
  end;
  if not v_error then raise exception 'confirmation moved requestedRelease while code build A held slot'; end if;

  -- 2. Releasing code build A frees the slot and records deploy-code-a as reconciled.
  reset role;
  set local role service_role;
  perform public.blog_build_release_code_slot('deploy-code-a', v_gen_code, 'ready', 'deploy-code-a');

  v_error := false;
  begin
    perform public.blog_build_acquire('deploy-code-a', null);
  exception when sqlstate '40001' then v_error := true;
  end;
  if not v_error then raise exception 'already-reconciled deploy-code-a re-acquired slot'; end if;

  reset role;
  set local role authenticated;
  v_release := public.blog_freeze_release(v_request, 1, v_app_session, v_summary->>'digest');
  v_release_id := (v_release->>'releaseId')::uuid;

  reset role;
  set local role service_role;
  perform set_config('request.jwt.claim.role', 'service_role', true);
  v_status := public.blog_publication_current(v_owner, v_app_session, v_provider_session, 1);
  if (v_status->>'requestId')::uuid is distinct from v_request or v_status->>'state' <> 'confirmed' then
    raise exception 'editor should be able to resume this confirmed request';
  end if;
  v_error := false;
  begin
    perform public.blog_publication_current(v_owner, v_app_session, gen_random_uuid(), 1);
  exception when sqlstate '42501' then v_error := true;
  end;
  if not v_error then raise exception 'another provider session could read current publication'; end if;
  perform set_config('request.jwt.claim.role', '', true);

  perform public.blog_publication_dispatch_claim(v_owner, v_app_session, v_provider_session, 1, v_request, v_attempt);

  -- Code build or mismatched hook payload cannot acquire reserved editorial slot.
  v_error := false;
  begin
    perform public.blog_build_acquire('deploy-code-late', null);
  exception when sqlstate '40001' then v_error := true;
  end;
  if not v_error then raise exception 'code build acquired reserved editorial slot'; end if;

  v_error := false;
  begin
    perform public.blog_build_acquire('deploy-wrong-hook', jsonb_build_object('requestId', v_request, 'releaseId', v_release_id, 'attemptId', gen_random_uuid()));
  exception when sqlstate '40001' then v_error := true;
  end;
  if not v_error then raise exception 'mismatched attempt hook acquired editorial slot'; end if;

  -- 3. Matching editorial hook acquires slot and marks building; late Task 7 dispatch result cannot downgrade it.
  v_acquired := public.blog_build_acquire('deploy-ed-1', jsonb_build_object('requestId', v_request, 'releaseId', v_release_id, 'attemptId', v_attempt));
  v_gen_editorial := (v_acquired->>'generation')::bigint;
  if v_acquired->>'buildKind' <> 'editorial' or (v_acquired->>'releaseId')::uuid is distinct from v_release_id then
    raise exception 'editorial hook did not acquire exact release';
  end if;

  perform public.blog_build_assert_current('deploy-ed-1', v_release_id, v_gen_editorial);

  v_status := public.blog_publication_dispatch_result(v_owner, v_app_session, v_provider_session, 1, v_request, v_attempt, 'queued');
  if v_status->>'state' <> 'building' then
    raise exception 'late Task 7 dispatch result downgraded building status to %', v_status->>'state';
  end if;

  -- 4. Guarded reconcile: stale generation, missing published pointer, or wrong published pointer fail.
  v_error := false;
  begin
    perform public.blog_publication_reconcile_commit(v_owner, v_app_session, v_provider_session, 1, v_request, v_gen_editorial - 1, 'deploy-ed-1', 'live', 'deploy-ed-1');
  exception when sqlstate '40001' then v_error := true;
  end;
  if not v_error then raise exception 'stale generation reconcile succeeded'; end if;

  v_error := false;
  begin
    perform public.blog_publication_reconcile_commit(v_owner, v_app_session, v_provider_session, 1, v_request, v_gen_editorial, 'deploy-ed-1', 'failed', null);
  exception when sqlstate '22023' then v_error := true;
  end;
  if not v_error then raise exception 'failed reconcile without published pointer succeeded'; end if;

  v_status := public.blog_publication_reconcile_commit(v_owner, v_app_session, v_provider_session, 1, v_request, v_gen_editorial, 'deploy-ed-1', 'failed', 'deploy-code-a');
  if v_status->>'state' <> 'failed' then raise exception 'reconcile failed did not persist failed'; end if;

  -- Failure keeps editorial reservation and preserves last_published_release_id = base_release.
  reset role;
  if (select active_request_id from blog_private.build_slot where singleton) is distinct from v_request
    or (select last_published_release_id from blog_private.build_slot where singleton) is distinct from v_base_release then
    raise exception 'failed build released reservation or moved last_published_release_id';
  end if;
  set local role service_role;

  -- Code build cannot acquire while failed B still holds active_request_id; historical failed A cannot retry; deploy-ed-1 cannot re-acquire.
  v_error := false;
  begin
    perform public.blog_build_acquire('deploy-code-after-fail', null);
  exception when sqlstate '40001' then v_error := true;
  end;
  if not v_error then raise exception 'code build acquired slot while failed B was reserved'; end if;

  v_error := false;
  begin
    perform public.blog_publication_retry(v_owner, v_app_session, v_provider_session, 1, v_old_failed_request, gen_random_uuid());
  exception when sqlstate '40001' then v_error := true;
  end;
  if not v_error then raise exception 'historical inactive failed request retried'; end if;

  -- 5. Explicit retry after demonstrated failure preserves confirmed snapshot and allows fresh attempt -> live.
  v_status := public.blog_publication_retry(v_owner, v_app_session, v_provider_session, 1, v_request, v_retry_id);
  if v_status->>'state' <> 'confirmed' or (v_status->>'releaseId')::uuid is distinct from v_release_id then
    raise exception 'retry did not preserve confirmed snapshot';
  end if;

  perform public.blog_publication_dispatch_claim(v_owner, v_app_session, v_provider_session, 1, v_request, v_retry_attempt);
  perform public.blog_publication_dispatch_result(v_owner, v_app_session, v_provider_session, 1, v_request, v_retry_attempt, 'queued');
  v_acquired := public.blog_build_acquire('deploy-ed-2', jsonb_build_object('requestId', v_request, 'releaseId', v_release_id, 'attemptId', v_retry_attempt));
  v_gen_editorial := (v_acquired->>'generation')::bigint;

  v_status := public.blog_publication_reconcile_commit(v_owner, v_app_session, v_provider_session, 1, v_request, v_gen_editorial, 'deploy-ed-2', 'live', 'deploy-ed-2');
  if v_status->>'state' <> 'live' then raise exception 'reconcile live did not persist live'; end if;
  reset role;
  if (select last_published_release_id from blog_private.build_slot where singleton) is distinct from v_release_id
    or (select active_request_id from blog_private.build_slot where singleton) is not null then
    raise exception 'live build did not advance last_published_release_id or clear slot';
  end if;
end;
$task8_build_slot$;

rollback;
