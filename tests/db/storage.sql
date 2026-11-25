begin;

do $task5_storage$
declare
  v_owner_id constant uuid := '00000000-0000-0000-0000-000000000103';
  v_other_id constant uuid := '00000000-0000-0000-0000-000000000104';
  v_session_id constant uuid := '00000000-0000-0000-0000-000000000205';
  v_media_id constant text := '00000000-0000-4000-8000-000000000305';
  v_width integer;
  v_height integer;
  v_sha text;
  v_variant jsonb;
  v_variants jsonb;
  v_release_id uuid;
  v_post_id uuid;
  v_post_revision bigint;
  v_manifest jsonb;
  v_result jsonb;
  v_summary jsonb;
begin
  if not exists (select 1 from storage.buckets where id = 'blog-drafts' and not public and file_size_limit = 1048576 and allowed_mime_types = array['image/webp']) then
    raise exception 'private draft bucket must enforce WebP and one MiB';
  end if;
  if not exists (select 1 from storage.buckets where id = 'blog-public' and public and file_size_limit = 1048576 and allowed_mime_types = array['image/webp']) then
    raise exception 'public media bucket must enforce WebP and one MiB';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'storage.objects'::regclass) then
    raise exception 'Storage object access requires RLS';
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'jt_blog_drafts_owner_select')
    or not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'jt_blog_drafts_owner_insert') then
    raise exception 'private draft owner policies are missing';
  end if;
  if has_function_privilege('anon', 'blog_private.blog_storage_request_authorized()', 'EXECUTE')
    or not has_function_privilege('authenticated', 'blog_private.blog_storage_request_authorized()', 'EXECUTE')
    or has_function_privilege('service_role', 'blog_private.blog_storage_request_authorized()', 'EXECUTE') then
    raise exception 'Storage authority helper must be callable only by the authenticated policy role';
  end if;
  if has_function_privilege('anon', 'public.blog_media_record_variant(uuid,uuid,bigint,text,jsonb)', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.blog_media_record_variant(uuid,uuid,bigint,text,jsonb)', 'EXECUTE')
    or not has_function_privilege('service_role', 'public.blog_media_record_variant(uuid,uuid,bigint,text,jsonb)', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.blog_media_complete(uuid,uuid,bigint,text)', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.blog_media_promotion_manifest(uuid,uuid,bigint,text[])', 'EXECUTE') then
    raise exception 'complete/record/promotion storage helpers must be trusted server only';
  end if;
  if has_table_privilege('authenticated', 'public.blog_media', 'INSERT,UPDATE,DELETE')
    or has_table_privilege('service_role', 'public.blog_media', 'SELECT,INSERT,UPDATE,DELETE') then
    raise exception 'media rows must not expose generic authenticated or service CRUD';
  end if;

  insert into auth.users(id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values (v_owner_id, 'authenticated', 'authenticated', 'task5-storage-fixture@example.invalid', '', clock_timestamp(), '{}'::jsonb, '{}'::jsonb, clock_timestamp(), clock_timestamp());
  insert into auth.sessions(id, user_id, created_at, updated_at, not_after)
  values (v_session_id, v_owner_id, clock_timestamp(), clock_timestamp(), null);
  update blog_private.settings set authorized_owner_id = v_owner_id where singleton;
  insert into blog_private.admin_sessions (session_id, user_id, auth_session_id, generation, expires_at)
  values (v_session_id, v_owner_id, v_session_id, 1, clock_timestamp() + interval '10 minutes');
  update blog_private.admin_sessions set auth_expires_at = clock_timestamp() + interval '10 minutes' where session_id = v_session_id;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_owner_id::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_owner_id, 'session_id', v_session_id, 'exp', floor(extract(epoch from clock_timestamp()))::bigint + 600)::text, true);
  if not blog_private.blog_storage_request_authorized() then raise exception 'configured owner with live app/provider session should pass the Storage policy helper'; end if;
  perform set_config('request.jwt.claim.sub', v_other_id::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_other_id, 'session_id', v_session_id, 'exp', floor(extract(epoch from clock_timestamp()))::bigint + 600)::text, true);
  if blog_private.blog_storage_request_authorized() then raise exception 'another Auth account must not pass the editor Storage policy'; end if;
  perform set_config('request.jwt.claim.sub', v_owner_id::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_owner_id, 'session_id', v_session_id, 'exp', floor(extract(epoch from clock_timestamp()))::bigint - 1)::text, true);
  if blog_private.blog_storage_request_authorized() then raise exception 'expired provider JWT must not pass the Storage policy'; end if;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_owner_id, 'session_id', v_session_id, 'exp', floor(extract(epoch from clock_timestamp()))::bigint + 600)::text, true);
  reset role;
  delete from auth.sessions where id = v_session_id;
  set local role authenticated;
  if blog_private.blog_storage_request_authorized() then raise exception 'revoked provider session must not pass the Storage policy'; end if;
  reset role;
  insert into auth.sessions(id, user_id, created_at, updated_at, not_after)
  values (v_session_id, v_owner_id, clock_timestamp(), clock_timestamp(), null);

  set local role service_role;
  v_sha := repeat('a', 64);
  v_variant := jsonb_build_object('width', 1200, 'height', 800, 'mime', 'image/webp', 'byteLength', 2200,
    'sha256', v_sha, 'objectKey', 'public/' || v_media_id || '/1200-' || v_sha || '.webp');
  if public.blog_media_record_variant(v_owner_id, v_session_id, 1, v_media_id, v_variant) is distinct from true then
    raise exception 'server should record validated immutable variants';
  end if;
  begin
    perform public.blog_media_complete(v_owner_id, v_session_id, 1, v_media_id);
    raise exception 'a master without required smaller variants was accepted';
  exception when sqlstate '22023' then null;
  end;
  if public.blog_media_record_variant(v_owner_id, v_session_id, 1, v_media_id, v_variant) is distinct from true then
    raise exception 'an identical master retry should be idempotent';
  end if;
  begin
    perform public.blog_media_record_variant(v_other_id, v_session_id, 1, v_media_id, v_variant);
    raise exception 'a different owner used the active app session';
  exception when sqlstate '42501' then null;
  end;
  begin
    v_variant := jsonb_set(v_variant, '{mime}', '"image/png"'::jsonb);
    perform public.blog_media_record_variant(v_owner_id, v_session_id, 1, v_media_id, v_variant);
    raise exception 'non-WebP media manifest was accepted';
  exception when sqlstate '22023' then null;
  end;
  v_variant := jsonb_build_object('width', 960, 'height', 640, 'mime', 'image/webp', 'byteLength', 1800,
    'sha256', repeat('b', 64), 'objectKey', 'public/' || v_media_id || '/960-' || repeat('b', 64) || '.webp');
  perform public.blog_media_record_variant(v_owner_id, v_session_id, 1, v_media_id, v_variant);
  v_variant := jsonb_build_object('width', 480, 'height', 320, 'mime', 'image/webp', 'byteLength', 900,
    'sha256', repeat('c', 64), 'objectKey', 'public/' || v_media_id || '/480-' || repeat('c', 64) || '.webp');
  perform public.blog_media_record_variant(v_owner_id, v_session_id, 1, v_media_id, v_variant);
  v_variants := public.blog_media_complete(v_owner_id, v_session_id, 1, v_media_id) -> 'variants';
  reset role;
  if jsonb_array_length(v_variants) <> 3 or not blog_private.media_group_valid(v_media_id, v_owner_id) then
    raise exception 'complete media must have the exact proportional immutable width set';
  end if;

  set local role service_role;
  begin
    v_variant := jsonb_build_object('width', 1200, 'height', 800, 'mime', 'image/webp', 'byteLength', 2200,
      'sha256', repeat('d', 64), 'objectKey', 'public/' || v_media_id || '/1200-' || repeat('d', 64) || '.webp');
    perform public.blog_media_record_variant(v_owner_id, v_session_id, 1, v_media_id, v_variant);
    raise exception 'complete media width was overwritten';
  exception when sqlstate '23505' then null;
  end;

  reset role;
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_owner_id::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_owner_id, 'session_id', v_session_id, 'exp', floor(extract(epoch from clock_timestamp()))::bigint + 600)::text, true);
  v_result := public.blog_save_post(jsonb_build_object(
    'title', 'Task 5 media promotion fixture',
    'slug', 'task5-media-promotion-' || replace(v_media_id, '-', ''),
    'excerpt', 'Synthetic immutable release for the Task 5 media proof',
    'document', '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Task 5 fixture body"}]}]}'::jsonb,
    'coverMediaId', v_media_id,
    'serviceId', null
  ), 0, v_session_id, 1);
  v_post_id := (v_result ->> 'id')::uuid;
  v_post_revision := (v_result ->> 'revision')::bigint;
  perform public.blog_mark_prepared(v_post_id, v_post_revision, 'upsert', v_session_id, 1);
  v_summary := public.blog_publication_summary(v_session_id, 1);
  v_result := public.blog_freeze_release(gen_random_uuid(), 1, v_session_id, v_summary ->> 'digest');
  v_release_id := (v_result ->> 'releaseId')::uuid;
  reset role;
  if not exists (
    select 1
    from blog_private.releases r
    cross join lateral jsonb_array_elements(r.payload_text::jsonb -> 'posts') post
    where r.release_id = v_release_id
      and encode(extensions.digest(convert_to(r.payload_text, 'UTF8'), 'sha256'), 'hex') = r.digest
      and post.value -> 'coverMedia' ->> 'id' = v_media_id
  ) then
    raise exception 'promotion fixture must use a new immutable confirmed release with the media reference';
  end if;

  set local role service_role;
  v_manifest := public.blog_media_promotion_manifest(v_owner_id, v_session_id, 1, array[v_media_id]);
  if jsonb_array_length(v_manifest) <> 1 or v_manifest -> 0 ->> 'id' <> v_media_id then
    raise exception 'promotion manifest must expose only exact confirmed immutable media';
  end if;
  begin
    perform public.blog_media_promotion_manifest(v_owner_id, v_session_id, 1, array['00000000-0000-4000-8000-000000000306']);
    raise exception 'unconfirmed media was eligible for public promotion';
  exception when sqlstate '42501' then null;
  end;
  reset role;

  update auth.sessions set not_after = clock_timestamp() - interval '1 second' where id = v_session_id;
  set local role service_role;
  begin
    perform public.blog_media_revalidate_session(v_owner_id, v_session_id, 1);
    raise exception 'expired provider session passed media revalidation';
  exception when sqlstate '42501' then null;
  end;
  reset role;
  update auth.sessions set not_after = null where id = v_session_id;
  update blog_private.admin_sessions set expires_at = clock_timestamp() - interval '1 second' where session_id = v_session_id;
  set local role service_role;
  begin
    perform public.blog_media_revalidate_session(v_owner_id, v_session_id, 1);
    raise exception 'expired application session passed media revalidation';
  exception when sqlstate '42501' then null;
  end;
  reset role;
  update blog_private.admin_sessions set expires_at = clock_timestamp() + interval '10 minutes' where session_id = v_session_id;
  update blog_private.admin_sessions set revoked_at = clock_timestamp() where session_id = v_session_id;
  set local role service_role;
  begin
    perform public.blog_media_complete(v_owner_id, v_session_id, 1, v_media_id);
    raise exception 'revoked admin session completed media';
  exception when sqlstate '42501' then null;
  end;
  reset role;
end;
$task5_storage$;

rollback;
