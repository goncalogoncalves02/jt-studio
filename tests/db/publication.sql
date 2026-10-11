begin;

do $task3_publication$
declare
  v_empty_release record;
  v_owner_id constant uuid := '00000000-0000-0000-0000-000000000104';
  v_session_id constant uuid := '00000000-0000-0000-0000-000000000204';
  v_result jsonb;
  v_summary jsonb;
  v_payload jsonb;
  v_base_posts jsonb;
  v_post_id uuid;
  v_index integer;
  v_slug_prefix text := 'snapshot-' || gen_random_uuid()::text;
begin
  select * into v_empty_release
  from blog_private.releases
  order by created_at asc
  limit 1;

  if v_empty_release.release_id is null then
    raise exception 'an explicit initial release must be seeded';
  end if;
  if v_empty_release.payload_text is null or v_empty_release.digest is null then
    raise exception 'release payload text and digest must be stored together';
  end if;
  if v_empty_release.payload_text::jsonb -> 'posts' <> '[]'::jsonb then
    raise exception 'the initial release must be explicitly empty';
  end if;
  if encode(extensions.digest(convert_to(v_empty_release.payload_text, 'UTF8'), 'sha256'), 'hex') <> v_empty_release.digest then
    raise exception 'release digest must cover the exact stored payload text';
  end if;
  if not exists (select 1 from blog_private.build_slot where singleton) then
    raise exception 'the shared build/publication lock row must exist';
  end if;
  if not exists (
    select 1
    from blog_private.build_slot b
    join blog_private.releases r on r.release_id = b.latest_confirmed_release_id
    where b.singleton
      and b.generation >= 0
      and encode(extensions.digest(convert_to(r.payload_text, 'UTF8'), 'sha256'), 'hex') = r.digest
  ) then
    raise exception 'the build-slot pointer must reference an intact confirmed release';
  end if;
  if has_table_privilege('authenticated', 'blog_private.releases', 'SELECT,INSERT,UPDATE,DELETE')
    or has_table_privilege('anon', 'blog_private.publication_requests', 'SELECT,INSERT,UPDATE,DELETE') then
    raise exception 'private release and build state must stay outside direct API table grants';
  end if;
  begin
    update blog_private.releases set payload_text = payload_text || ' ' where release_id = v_empty_release.release_id;
    raise exception 'release mutation unexpectedly succeeded';
  exception when sqlstate '55000' then
    null;
  end;

  update blog_private.settings set authorized_owner_id = v_owner_id where singleton;
  insert into blog_private.admin_sessions (session_id, user_id, generation, expires_at)
  values (v_session_id, v_owner_id, 1, clock_timestamp() + interval '10 minutes');
  perform set_config('request.jwt.claim.sub', v_owner_id::text, true);

  select r.payload_text::jsonb -> 'posts' into v_base_posts
  from blog_private.build_slot b
  join blog_private.releases r on r.release_id = b.latest_confirmed_release_id
  where b.singleton
  for update of b;

  if v_base_posts is null or jsonb_typeof(v_base_posts) <> 'array' then
    raise exception 'the current confirmed release must contain a posts array';
  end if;

  for v_index in 1..101 loop
    v_result := public.blog_save_post(jsonb_build_object(
      'title', format('Snapshot %s', v_index),
      'slug', v_slug_prefix || '-' || v_index,
      'excerpt', 'Ready snapshot fixture',
      'document', '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Body"}]}]}'::jsonb,
      'coverMediaId', null,
      'serviceId', null
    ), 0, v_session_id, 1);
    v_post_id := (v_result ->> 'id')::uuid;
    perform public.blog_mark_prepared(v_post_id, 1, 'upsert', v_session_id, 1);
  end loop;
  v_summary := public.blog_publication_summary(v_session_id, 1);
  v_payload := (public.blog_freeze_release(
    '00000000-0000-0000-0000-000000000304', 1, v_session_id, v_summary ->> 'digest'
  ) ->> 'payload')::jsonb -> 'posts';
  if jsonb_array_length(v_payload) <> jsonb_array_length(v_base_posts) + 101 then
    raise exception 'freezing 101 new posts must preserve the existing snapshot base';
  end if;
end;
$task3_publication$;

rollback;
