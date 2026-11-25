begin;

create temporary table task3_publication_owned_fixture (
  request_id uuid primary key,
  release_id uuid not null,
  owner_id uuid not null,
  generation bigint not null
) on commit drop;

create function pg_temp.task3_fail_release_own_reservation(p_request_id uuid) returns void
language plpgsql
set search_path=pg_catalog,blog_private,pg_temp
as $$
declare v_fixture record; v_rows integer;
begin
  select q.request_id,q.release_id,q.owner_id,q.publication_generation
    into strict v_fixture
  from blog_private.build_slot b
  join blog_private.publication_requests q on q.request_id=b.active_request_id
  join blog_private.settings s on s.singleton
  where b.singleton and b.active_request_id=p_request_id
    and b.latest_confirmed_release_id=q.release_id
    and b.generation=q.publication_generation
    and q.owner_id=s.authorized_owner_id and q.state='confirmed'
    and not exists(select 1 from blog_private.publication_dispatch_attempts a where a.request_id=q.request_id)
  for update of b,q;
  insert into task3_publication_owned_fixture(request_id,release_id,owner_id,generation)
  values(v_fixture.request_id,v_fixture.release_id,v_fixture.owner_id,v_fixture.publication_generation);
  update blog_private.publication_requests q
    set state='failed',updated_at=clock_timestamp()
    where q.request_id=v_fixture.request_id and q.owner_id=v_fixture.owner_id
      and q.release_id=v_fixture.release_id and q.publication_generation=v_fixture.publication_generation
      and q.state='confirmed'
      and not exists(select 1 from blog_private.publication_dispatch_attempts a where a.request_id=q.request_id);
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then raise exception 'Task 3 owned request failure affected % rows; expected one',v_rows; end if;
  update blog_private.build_slot b
    set active_request_id=null,updated_at=clock_timestamp()
    where b.singleton and b.active_request_id=v_fixture.request_id
      and b.latest_confirmed_release_id=v_fixture.release_id
      and b.generation=v_fixture.publication_generation
      and exists(select 1 from blog_private.publication_requests q where q.request_id=v_fixture.request_id
        and q.owner_id=v_fixture.owner_id and q.release_id=v_fixture.release_id
        and q.publication_generation=v_fixture.publication_generation and q.state='failed')
      and not exists(select 1 from blog_private.publication_dispatch_attempts a where a.request_id=v_fixture.request_id);
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then raise exception 'Task 3 owned slot release affected % rows; expected one',v_rows; end if;
end;
$$;

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
  v_request_id uuid := gen_random_uuid();
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
  insert into auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
  values(v_owner_id,'authenticated','authenticated','task3-publication-base@example.invalid','',clock_timestamp(),'{}'::jsonb,'{}'::jsonb,clock_timestamp(),clock_timestamp());
  insert into auth.sessions(id,user_id,created_at,updated_at,not_after)
  values(v_session_id,v_owner_id,clock_timestamp(),clock_timestamp(),null);
  insert into blog_private.admin_sessions (session_id, user_id, auth_session_id, generation, expires_at, auth_expires_at)
  values (v_session_id, v_owner_id, v_session_id, 1, clock_timestamp() + interval '10 minutes', clock_timestamp() + interval '10 minutes');
  perform set_config('request.jwt.claim.sub', v_owner_id::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub',v_owner_id,'session_id',v_session_id)::text, true);

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
    v_request_id, 1, v_session_id, v_summary ->> 'digest'
  ) ->> 'payload')::jsonb -> 'posts';
  if jsonb_array_length(v_payload) <> jsonb_array_length(v_base_posts) + 101 then
    raise exception 'freezing 101 new posts must preserve the existing snapshot base';
  end if;
  perform pg_temp.task3_fail_release_own_reservation(v_request_id);
end;
$task3_publication$;

do $task3_publication_scenarios$
declare
  v_owner_id constant uuid := gen_random_uuid();
  v_session_id constant uuid := gen_random_uuid();
  v_slug_prefix text := 'batch-' || gen_random_uuid()::text;
  v_base_id uuid;
  v_first_release_id uuid;
  v_second_release_id uuid;
  v_third_release_id uuid;
  v_a_id uuid;
  v_b_id uuid;
  v_c_id uuid;
  v_d_id uuid;
  v_e_id uuid;
  v_g_id uuid;
  v_result jsonb;
  v_summary jsonb;
  v_first jsonb;
  v_second jsonb;
  v_replay jsonb;
  v_payload jsonb;
  v_first_a jsonb;
  v_candidate jsonb;
  v_count_before bigint;
  v_stale boolean;
  v_base_posts jsonb;
  v_row public.blog_posts%rowtype;
  v_digest text;
  v_request_one uuid := gen_random_uuid();
  v_request_two uuid := gen_random_uuid();
  v_request_three uuid := gen_random_uuid();
  v_request_four uuid := gen_random_uuid();
  v_replay_count bigint;
begin
  select b.latest_confirmed_release_id, r.payload_text::jsonb -> 'posts'
    into v_base_id, v_base_posts
  from blog_private.build_slot b
  join blog_private.releases r on r.release_id = b.latest_confirmed_release_id
  where b.singleton
  for update of b;
  if v_base_id is null or jsonb_typeof(v_base_posts) is distinct from 'array' then
    raise exception 'publication scenario requires an existing confirmed base';
  end if;

  update blog_private.settings set authorized_owner_id = v_owner_id where singleton;
  insert into auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
  values(v_owner_id,'authenticated','authenticated','task3-publication-scenarios-'||v_owner_id||'@example.invalid','',clock_timestamp(),'{}'::jsonb,'{}'::jsonb,clock_timestamp(),clock_timestamp());
  insert into auth.sessions(id,user_id,created_at,updated_at,not_after)
  values(v_session_id,v_owner_id,clock_timestamp(),clock_timestamp(),null);
  insert into blog_private.admin_sessions(session_id,user_id,auth_session_id,generation,expires_at,auth_expires_at)
  values (v_session_id,v_owner_id,v_session_id,1,clock_timestamp()+interval '10 minutes',clock_timestamp()+interval '10 minutes');
  perform set_config('request.jwt.claim.sub',v_owner_id::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_owner_id,'session_id',v_session_id)::text,true);

  v_result := public.blog_save_post(jsonb_build_object(
    'title','Scenario A published','slug',v_slug_prefix||'-a','excerpt','A retained from a complete prior release',
    'document','{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"A exact body"}]}]}'::jsonb,
    'coverMediaId',null,'serviceId',null),0,v_session_id,1);
  v_a_id := (v_result->>'id')::uuid;
  v_result := public.blog_save_post(jsonb_build_object(
    'title','Scenario D published then removed','slug',v_slug_prefix||'-d','excerpt','D has a prepared removal',
    'document','{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"D exact body"}]}]}'::jsonb,
    'coverMediaId',null,'serviceId',null),0,v_session_id,1);
  v_d_id := (v_result->>'id')::uuid;
  v_result := public.blog_save_post(jsonb_build_object(
    'title','Scenario C draft','slug',v_slug_prefix||'-c','excerpt','Never prepared',
    'document','{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"C draft body"}]}]}'::jsonb,
    'coverMediaId',null,'serviceId',null),0,v_session_id,1);
  v_c_id := (v_result->>'id')::uuid;
  perform public.blog_mark_prepared(v_a_id,1,'upsert',v_session_id,1);
  perform public.blog_mark_prepared(v_d_id,1,'upsert',v_session_id,1);
  v_summary := public.blog_publication_summary(v_session_id,1);
  v_first := public.blog_freeze_release(v_request_one,1,v_session_id,v_summary->>'digest');
  v_first_release_id := (v_first->>'releaseId')::uuid;
  v_payload := (v_first->>'payload')::jsonb;
  if jsonb_array_length(v_payload->'posts') <> jsonb_array_length(v_base_posts)+2
    or not (v_payload->'posts' @> v_base_posts) then
    raise exception 'first complete release lost unrelated confirmed base posts or omitted A/D';
  end if;
  select value into v_first_a from jsonb_array_elements(v_payload->'posts') where value->>'id'=v_a_id::text;
  select * into v_row from public.blog_posts where id=v_a_id;
  if v_first_a is null or v_first_a->>'title' <> 'Scenario A published'
    or v_first_a->>'slug' <> v_slug_prefix||'-a'
    or v_first_a->'document' <> '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"A exact body"}]}]}'::jsonb
    or v_first_a->'publishedAt' is null or v_first_a->'modifiedAt' is null
    or v_row.first_confirmed_at is null
    or v_first_a is distinct from blog_private.public_post_json(v_row,v_row.first_confirmed_at) then
    raise exception 'first release A identity, complete content, or dates are not exact';
  end if;
  if encode(extensions.digest(convert_to(v_first->>'payload','UTF8'),'sha256'),'hex') <> v_first->>'digest'
    or not exists(select 1 from blog_private.releases r where r.release_id=v_first_release_id and r.payload_text=v_first->>'payload' and r.digest=v_first->>'digest') then
    raise exception 'first release exact bytes and digest were not persisted';
  end if;
  perform pg_temp.task3_fail_release_own_reservation(v_request_one);

  perform public.blog_mark_prepared(v_d_id,1,'remove',v_session_id,1);
  v_result := public.blog_save_post(jsonb_build_object(
    'title','Scenario B ready','slug',v_slug_prefix||'-b','excerpt','B enters this later release',
    'document','{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"B exact body"}]}]}'::jsonb,
    'coverMediaId',null,'serviceId',null),0,v_session_id,1);
  v_b_id := (v_result->>'id')::uuid;
  perform public.blog_mark_prepared(v_b_id,1,'upsert',v_session_id,1);
  v_summary := public.blog_publication_summary(v_session_id,1);
  v_digest := v_summary->>'digest';
  v_second := public.blog_freeze_release(v_request_two,1,v_session_id,v_digest);
  v_second_release_id := (v_second->>'releaseId')::uuid;
  v_payload := (v_second->>'payload')::jsonb;
  if not exists(select 1 from blog_private.releases r where r.release_id=v_second_release_id and r.base_release_id=v_first_release_id)
    or (select state from blog_private.publication_requests where request_id=v_request_one) <> 'failed' then
    raise exception 'failed prior publication must remain the next complete base';
  end if;
  if jsonb_array_length(v_payload->'posts') <> jsonb_array_length(v_base_posts)+2
    or not (v_payload->'posts' @> v_base_posts)
    or exists(select 1 from jsonb_array_elements(v_payload->'posts') p where p->>'id'=v_d_id::text or p->>'id'=v_c_id::text)
    or not exists(select 1 from jsonb_array_elements(v_payload->'posts') p where p->>'id'=v_a_id::text)
    or not exists(select 1 from jsonb_array_elements(v_payload->'posts') p where p->>'id'=v_b_id::text) then
    raise exception 'complete A+B output must retain base, include ready B, and exclude removed D and draft C';
  end if;
  select value into v_candidate from jsonb_array_elements(v_payload->'posts') where value->>'id'=v_a_id::text;
  if v_candidate is distinct from v_first_a then raise exception 'retained published A changed in the next complete payload'; end if;
  select value into v_candidate from jsonb_array_elements(v_payload->'posts') where value->>'id'=v_b_id::text;
  select * into v_row from public.blog_posts where id=v_b_id;
  if v_candidate is distinct from blog_private.public_post_json(v_row,v_row.first_confirmed_at)
    or v_candidate->>'title' <> 'Scenario B ready'
    or v_candidate->'document' <> '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"B exact body"}]}]}'::jsonb then
    raise exception 'ready B identity, content, or publication dates do not match its persisted row';
  end if;
  if encode(extensions.digest(convert_to(v_second->>'payload','UTF8'),'sha256'),'hex') <> v_second->>'digest'
    or not exists(select 1 from blog_private.releases r where r.release_id=v_second_release_id and r.payload_text=v_second->>'payload' and r.digest=v_second->>'digest') then
    raise exception 'second release exact bytes and digest were not persisted';
  end if;
  select count(*) into v_count_before from blog_private.releases;

  v_result := public.blog_save_post(jsonb_build_object(
    'title','Scenario E new readiness','slug',v_slug_prefix||'-e','excerpt','Must survive a replay',
    'document','{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"E body"}]}]}'::jsonb,
    'coverMediaId',null,'serviceId',null),0,v_session_id,1);
  v_e_id := (v_result->>'id')::uuid;
  perform public.blog_mark_prepared(v_e_id,1,'upsert',v_session_id,1);
  v_replay := public.blog_freeze_release(v_request_two,1,v_session_id,v_digest);
  select count(*) into v_replay_count from blog_private.releases;
  select * into v_row from public.blog_posts where id=v_e_id;
  if v_replay->>'releaseId' <> v_second->>'releaseId'
    or v_replay->>'payload' <> v_second->>'payload'
    or v_replay->>'digest' <> v_second->>'digest'
    or v_replay_count <> v_count_before
    or v_row.prepared_action <> 'upsert' or v_row.first_confirmed_at is not null then
    raise exception 'same request/digest replay must return exact bytes without a new release or consuming later readiness';
  end if;
  v_stale := false;
  begin
    perform public.blog_freeze_release(v_request_two,1,v_session_id,repeat('0',64));
  exception when sqlstate '40001' then v_stale := true;
  end;
  if not v_stale then raise exception 'same request id with a conflicting digest must fail'; end if;

  perform pg_temp.task3_fail_release_own_reservation(v_request_two);

  v_summary := public.blog_publication_summary(v_session_id,1);
  v_digest := v_summary->>'digest';
  v_result := public.blog_save_post(jsonb_build_object(
    'id',v_e_id,'title','Scenario E revised','slug',v_slug_prefix||'-e','excerpt','Must survive a replay',
    'document','{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"E revised"}]}]}'::jsonb,
    'coverMediaId',null,'serviceId',null),1,v_session_id,1);
  v_stale := false;
  begin
    perform public.blog_freeze_release(v_request_three,1,v_session_id,v_digest);
  exception when sqlstate '40001' then v_stale := true;
  end;
  select count(*) into v_replay_count from blog_private.releases;
  if not v_stale or v_replay_count <> v_count_before or exists(select 1 from blog_private.publication_requests where request_id=v_request_three) then
    raise exception 'revision-stale summary must fail without creating partial release state';
  end if;

  perform public.blog_mark_prepared(v_a_id,1,'remove',v_session_id,1);
  v_summary := public.blog_publication_summary(v_session_id,1);
  v_digest := v_summary->>'digest';
  perform public.blog_mark_prepared(v_a_id,1,'upsert',v_session_id,1);
  v_stale := false;
  begin
    perform public.blog_freeze_release(gen_random_uuid(),1,v_session_id,v_digest);
  exception when sqlstate '40001' then v_stale := true;
  end;
  select count(*) into v_replay_count from blog_private.releases;
  if not v_stale or v_replay_count <> v_count_before then
    raise exception 'action-stale summary must fail without creating a release';
  end if;

  v_summary := public.blog_publication_summary(v_session_id,1);
  v_digest := v_summary->>'digest';
  v_first := public.blog_freeze_release(v_request_four,1,v_session_id,v_digest);
  v_third_release_id := (v_first->>'releaseId')::uuid;
  perform pg_temp.task3_fail_release_own_reservation(v_request_four);
  v_stale := false;
  begin
    perform public.blog_freeze_release(gen_random_uuid(),1,v_session_id,v_digest);
  exception when sqlstate '40001' then v_stale := true;
  end;
  if not v_stale or not exists(select 1 from blog_private.build_slot where singleton and latest_confirmed_release_id=v_third_release_id) then
    raise exception 'base-stale summary must fail closed after confirmed base advances';
  end if;

  v_result := public.blog_save_post(jsonb_build_object(
    'title','Scenario G after base','slug',v_slug_prefix||'-g','excerpt','Absent base cannot empty-fallback',
    'document','{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"G body"}]}]}'::jsonb,
    'coverMediaId',null,'serviceId',null),0,v_session_id,1);
  v_g_id := (v_result->>'id')::uuid;
  perform public.blog_mark_prepared(v_g_id,1,'upsert',v_session_id,1);
  update blog_private.build_slot set latest_confirmed_release_id=null where singleton;
  v_summary := public.blog_publication_summary(v_session_id,1);
  select count(*) into v_count_before from blog_private.releases;
  v_stale := false;
  begin
    perform public.blog_freeze_release(gen_random_uuid(),1,v_session_id,v_summary->>'digest');
  exception when sqlstate '55000' then v_stale := true;
  end;
  select count(*) into v_replay_count from blog_private.releases;
  if not v_stale or v_replay_count <> v_count_before then
    raise exception 'absent confirmed base must fail without an empty fallback snapshot';
  end if;
  update blog_private.build_slot set latest_confirmed_release_id=v_third_release_id where singleton;
end;
$task3_publication_scenarios$;

rollback;
