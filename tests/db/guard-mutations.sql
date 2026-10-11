begin;

do $task3_rls_mutation$
declare
  v_post_id uuid;
  v_visible_rows integer;
begin
  insert into public.blog_posts (owner_id, title, slug, document)
  values (
    '00000000-0000-0000-0000-000000000811',
    'Causal RLS fixture',
    'task3-rls-mutation-' || replace(gen_random_uuid()::text, '-', ''),
    '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"private fixture"}]}]}'::jsonb
  ) returning id into v_post_id;

  execute 'alter policy blog_posts_owner_select on public.blog_posts using (true)';
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000812', true);
  execute 'set local role authenticated';
  select count(*) into v_visible_rows from public.blog_posts where id = v_post_id;
  if v_visible_rows <> 1 then
    raise exception 'removing the owner predicate did not expose the foreign fixture';
  end if;
end;
$task3_rls_mutation$;

rollback;

begin;

do $task3_document_guard_mutation$
declare
  v_owner_id constant uuid := '00000000-0000-0000-0000-000000000813';
  v_session_id constant uuid := '00000000-0000-0000-0000-000000000814';
  v_input jsonb := '{
    "title":"Causal DocumentV1 guard fixture",
    "slug":"task3-document-guard-mutation",
    "excerpt":"Synthetic guard-mutation proof",
    "document":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"payload","attrs":{"onerror":"synthetic"}}]}]},
    "coverMediaId":null,
    "serviceId":null
  }'::jsonb;
  v_root_input jsonb := '{
    "title":"Causal non-doc root fixture",
    "slug":"task3-document-root-mutation",
    "excerpt":"Synthetic root validator proof",
    "document":{"type":"paragraph","content":[{"type":"text","text":"synthetic root body"}]},
    "coverMediaId":null,
    "serviceId":null
  }'::jsonb;
  v_result jsonb;
  v_root_id uuid;
begin
  update blog_private.settings set authorized_owner_id = v_owner_id where singleton;
  insert into blog_private.admin_sessions (session_id, user_id, auth_session_id, generation, expires_at)
  values (v_session_id, v_owner_id, v_session_id, 1, clock_timestamp() + interval '10 minutes');
  perform set_config('request.jwt.claim.sub', v_owner_id::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub',v_owner_id,'session_id',v_session_id)::text, true);

  begin
    perform public.blog_save_post(v_input, 0, v_session_id, 1);
    raise exception 'baseline DocumentV1 RPC accepted an unknown executable attribute';
  exception when sqlstate '22023' then
    null;
  end;

  execute $ddl$
    create or replace function blog_private.document_v1_valid(p_document jsonb)
    returns boolean language sql immutable set search_path = pg_catalog
    as 'select true'
  $ddl$;
  v_result := public.blog_save_post(v_input, 0, v_session_id, 1);
  if v_result ->> 'id' is null then
    raise exception 'removing the DocumentV1 validator did not admit the malformed RPC input';
  end if;
  if not exists (
    select 1 from public.blog_posts
    where id = (v_result ->> 'id')::uuid
      and document #>> '{content,0,content,0,attrs,onerror}' = 'synthetic'
  ) then
    raise exception 'the accepted RPC did not persist the synthetic unknown attribute';
  end if;
  v_result := public.blog_save_post(v_root_input, 0, v_session_id, 1);
  v_root_id := (v_result ->> 'id')::uuid;
  perform public.blog_mark_prepared(v_root_id, 1, 'upsert', v_session_id, 1);
  if not exists (
    select 1 from public.blog_posts where id = v_root_id and prepared_action = 'upsert'
      and document ->> 'type' = 'paragraph'
  ) then
    raise exception 'removing the DocumentV1 root guard did not allow a non-doc root to become ready';
  end if;
end;
$task3_document_guard_mutation$;

rollback;

begin;

do $task3_snapshot_guard_mutation$
declare
  v_release_id uuid;
  v_original_text text;
  v_changed_text text;
  v_updated_rows integer;
begin
  select release_id, payload_text into v_release_id, v_original_text
  from blog_private.releases order by created_at asc limit 1;
  if v_release_id is null then raise exception 'immutable release fixture is missing'; end if;

  execute $ddl$
    create or replace function blog_private.reject_release_mutation()
    returns trigger language plpgsql set search_path = pg_catalog
    as 'begin return new; end;'
  $ddl$;
  update blog_private.releases set payload_text = payload_text || ' ' where release_id = v_release_id;
  get diagnostics v_updated_rows = row_count;
  select payload_text into v_changed_text from blog_private.releases where release_id = v_release_id;
  if v_updated_rows <> 1 or v_changed_text is not distinct from v_original_text then
    raise exception 'removing the snapshot trigger did not permit mutation';
  end if;

  execute $ddl$
    create or replace function blog_private.reject_release_mutation()
    returns trigger language plpgsql set search_path = pg_catalog
    as 'begin raise exception ''release snapshots are immutable'' using errcode = ''55000''; end;'
  $ddl$;
end;
$task3_snapshot_guard_mutation$;

rollback;
