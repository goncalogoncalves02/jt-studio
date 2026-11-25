begin;

do $task3_editorial_inputs$
declare
  v_owner_id constant uuid := '00000000-0000-0000-0000-000000000103';
  v_session_id constant uuid := '00000000-0000-0000-0000-000000000203';
  v_post_id uuid;
  v_confirmed_post_id uuid;
  v_post_row public.blog_posts%rowtype;
  v_result jsonb;
begin
  update blog_private.settings
  set authorized_owner_id = v_owner_id
  where singleton;
  insert into auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
  values(v_owner_id,'authenticated','authenticated','task3-editorial-inputs@example.invalid','',clock_timestamp(),'{}'::jsonb,'{}'::jsonb,clock_timestamp(),clock_timestamp());
  insert into auth.sessions(id,user_id,created_at,updated_at,not_after)
  values(v_session_id,v_owner_id,clock_timestamp(),clock_timestamp(),null);
  insert into blog_private.admin_sessions (session_id, user_id, auth_session_id, generation, expires_at, auth_expires_at)
  values (v_session_id, v_owner_id, v_session_id, 1, clock_timestamp() + interval '10 minutes', clock_timestamp() + interval '10 minutes');
  perform set_config('request.jwt.claim.sub', v_owner_id::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub',v_owner_id,'session_id',v_session_id)::text, true);

  begin
    perform public.blog_save_post(
      '{"title":"Null revision must fail"}'::jsonb, null, v_session_id, 1
    );
    raise exception 'blog_save_post accepted a null expected revision';
  exception when sqlstate '22023' then
    null;
  end;

  begin
    perform public.blog_save_post(jsonb_build_object(
      'title', 'Non-document root',
      'slug', 'non-document-root',
      'excerpt', 'An outer paragraph is not DocumentV1',
      'document', '{"type":"paragraph","content":[{"type":"text","text":"Invalid root body"}]}'::jsonb,
      'coverMediaId', null,
      'serviceId', null
    ), 0, v_session_id, 1);
    raise exception 'blog_save_post accepted a non-doc DocumentV1 root';
  exception when sqlstate '22023' then
    null;
  end;

  insert into public.blog_posts (owner_id, title, slug, document, first_confirmed_at)
  values (
    v_owner_id,
    'Previously confirmed',
    'previously-confirmed',
    '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"body"}]}]}'::jsonb,
    clock_timestamp()
  )
  returning id into v_confirmed_post_id;

  begin
    perform public.blog_mark_prepared(v_post_id, null, 'remove', v_session_id, 1);
    raise exception 'blog_mark_prepared accepted a null expected revision';
  exception when sqlstate '22023' then
    null;
  end;

  begin
    perform public.blog_mark_prepared(v_post_id, 1, null, v_session_id, 1);
    raise exception 'blog_mark_prepared accepted a null action';
  exception when sqlstate '22023' then
    null;
  end;

  begin
    perform public.blog_freeze_release(null, 1, v_session_id, repeat('a', 64));
    raise exception 'blog_freeze_release accepted a null request id';
  exception when sqlstate '22023' then
    null;
  end;

  begin
    perform public.blog_freeze_release(
      '00000000-0000-0000-0000-000000000303', 1, v_session_id, null
    );
    raise exception 'blog_freeze_release accepted a null expected digest';
  exception when sqlstate '22023' then
    null;
  end;

  v_result := public.blog_save_post(jsonb_build_object(
    'title', repeat('t',160),
    'slug', 'a' || repeat('b-',59) || 'b',
    'excerpt', 'Texto pronto sem capa nem serviço específico.',
    'document', '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"A","marks":[{"type":"bold"}]},{"type":"text","text":" "},{"type":"text","text":"B","marks":[{"type":"italic"}]}]}]}'::jsonb,
    'coverMediaId', null,
    'serviceId', null
  ), 0, v_session_id, 1);
  v_post_id := (v_result ->> 'id')::uuid;
  select * into v_post_row from public.blog_posts where id = v_post_id;
  if v_post_row.title <> repeat('t',160) or char_length(v_post_row.slug) <> 120
    or v_post_row.cover_media_id is not null or v_post_row.service_id is not null
    or v_post_row.document -> 'content' -> 0 -> 'content' -> 1 ->> 'text' <> ' ' then
    raise exception 'approved title/slug bounds or optional cover/service were not stored';
  end if;
  v_result := public.blog_save_post(jsonb_build_object(
    'title', 'Whitespace-only body must remain a draft',
    'slug', 'whitespace-only-body',
    'excerpt', 'Apenas whitespace não conta como corpo pronto.',
    'document', '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":" \n\t\u00a0"}]}]}'::jsonb,
    'coverMediaId', null,
    'serviceId', null
  ), 0, v_session_id, 1);
  begin
    perform public.blog_mark_prepared((v_result ->> 'id')::uuid, 1, 'upsert', v_session_id, 1);
    raise exception 'whitespace-only body was accepted as ready';
  exception when sqlstate '22023' then
    null;
  end;

  v_result := public.blog_save_post(jsonb_build_object(
    'title', E'\t\n' || chr(160),
    'slug', 'blank-title-draft',
    'excerpt', 'Valid excerpt',
    'document', '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Valid body"}]}]}'::jsonb,
    'coverMediaId', null, 'serviceId', null
  ), 0, v_session_id, 1);
  begin
    perform public.blog_mark_prepared((v_result ->> 'id')::uuid, 1, 'upsert', v_session_id, 1);
    raise exception 'whitespace-only title was accepted as ready';
  exception when sqlstate '22023' then null;
  end;

  v_result := public.blog_save_post(jsonb_build_object(
    'title', 'Valid title',
    'slug', 'blank-excerpt-draft',
    'excerpt', chr(160) || chr(8192) || chr(65279),
    'document', '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Valid body"}]}]}'::jsonb,
    'coverMediaId', null, 'serviceId', null
  ), 0, v_session_id, 1);
  begin
    perform public.blog_mark_prepared((v_result ->> 'id')::uuid, 1, 'upsert', v_session_id, 1);
    raise exception 'whitespace-only excerpt was accepted as ready';
  exception when sqlstate '22023' then null;
  end;

  perform public.blog_mark_prepared(v_post_id, 1, 'upsert', v_session_id, 1);
  select * into v_post_row from public.blog_posts where id = v_post_id;
  if v_post_row.prepared_action <> 'upsert' then
    raise exception 'a text-only article without cover or service must be ready';
  end if;
  if blog_private.public_post_json(v_post_row, clock_timestamp()) -> 'coverMedia' is distinct from 'null'::jsonb then
    raise exception 'an omitted optional cover must be represented as coverMedia null';
  end if;

  begin
    perform public.blog_save_post(jsonb_build_object(
      'id', v_post_id,
      'title', 'Stale revision',
      'slug', v_post_row.slug,
      'excerpt', v_post_row.excerpt,
      'document', v_post_row.document,
      'coverMediaId', null,
      'serviceId', null
    ), 0, v_session_id, 1);
    raise exception 'blog_save_post accepted a stale revision';
  exception when sqlstate '40001' then
    null;
  end;

  begin
    perform public.blog_save_post(jsonb_build_object(
      'id', v_confirmed_post_id,
      'title', 'Confirmed slug cannot change',
      'slug', 'previously-confirmed-changed',
      'excerpt', 'Previously confirmed',
      'document', '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"body"}]}]}'::jsonb,
      'coverMediaId', null,
      'serviceId', null
    ), 1, v_session_id, 1);
    raise exception 'blog_save_post changed a confirmed slug';
  exception when sqlstate '23514' then
    null;
  end;

  v_result := public.blog_save_post(jsonb_build_object(
    'id', v_post_id,
    'title', 'Content changed after preparation',
    'slug', v_post_row.slug,
    'excerpt', 'Prepared state must be cleared by a content edit.',
    'document', v_post_row.document,
    'coverMediaId', null,
    'serviceId', null
  ), 1, v_session_id, 1);
  if (v_result ->> 'revision')::integer <> 2
    or (v_result ->> 'preparedAction') is not null
    or (v_result ->> 'preparedRevision') is not null then
    raise exception 'content edits must advance revision and clear stale preparation';
  end if;
end;
$task3_editorial_inputs$;

rollback;
