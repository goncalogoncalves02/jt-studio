create or replace function blog_private.document_v1_valid(p_document jsonb)
returns boolean
language plpgsql
immutable
set search_path = pg_catalog
as $$
declare
  v_nodes integer;
begin
  if p_document is null or jsonb_typeof(p_document) is distinct from 'object'
    or p_document ->> 'type' is distinct from 'doc'
    or octet_length(p_document::text) > 262144 then return false; end if;
  if not blog_private.document_node_valid(p_document, null, 0) then return false; end if;
  with recursive nodes(node) as (
    select p_document
    union all
    select child.value
    from nodes n
    cross join lateral jsonb_array_elements(case when jsonb_typeof(n.node -> 'content') = 'array' then n.node -> 'content' else '[]'::jsonb end) as child(value)
  )
  select count(*) into v_nodes from nodes;
  return v_nodes <= 5000;
end;
$$;

create or replace function blog_private.ready_post_valid(p_post public.blog_posts)
returns boolean
language plpgsql
stable
set search_path = pg_catalog, blog_private, public
as $$
declare
  v_media_id text;
begin
  if not blog_private.document_text_has_content(p_post.title)
    or not blog_private.document_text_has_content(p_post.slug)
    or not blog_private.document_text_has_content(p_post.excerpt)
    or not blog_private.document_v1_valid(p_post.document)
    or not blog_private.document_has_text(p_post.document) then
    return false;
  end if;
  if p_post.cover_media_id is not null and not blog_private.media_group_valid(p_post.cover_media_id, p_post.owner_id) then return false; end if;
  for v_media_id in select media_id from blog_private.document_media_ids(p_post.document) loop
    if not blog_private.media_group_valid(v_media_id, p_post.owner_id) then return false; end if;
  end loop;
  return true;
end;
$$;

create or replace function blog_private.mark_prepared(p_post_id uuid, p_expected_revision bigint, p_action text, p_session_id uuid, p_generation bigint)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, blog_private, public, auth
as $$
declare
  v_owner_id uuid;
  v_post public.blog_posts%rowtype;
begin
  v_owner_id := blog_private.assert_admin_session(p_session_id, p_generation);
  if p_expected_revision is null or p_action is null or p_action not in ('upsert', 'remove') then
    raise exception 'prepared action and expected revision are required' using errcode = '22023';
  end if;

  -- Match freeze's session -> build slot -> post ordering. Freeze's FOR UPDATE on the slot waits for this admission.
  perform 1 from blog_private.build_slot where singleton for key share;
  perform blog_private.revalidate_admin_session(p_session_id, p_generation, v_owner_id);

  select * into v_post from public.blog_posts where id = p_post_id and owner_id = v_owner_id for update;
  if not found then raise exception 'post is unavailable' using errcode = '42501'; end if;
  perform blog_private.revalidate_admin_session(p_session_id, p_generation, v_owner_id);
  if v_post.revision <> p_expected_revision then raise exception 'post revision is stale' using errcode = '40001'; end if;
  if p_action = 'upsert' and not blog_private.ready_post_valid(v_post) then
    raise exception 'article is not complete and ready' using errcode = '22023';
  end if;
  if p_action = 'remove' and v_post.first_confirmed_at is null then
    raise exception 'only a confirmed article can be removed' using errcode = '22023';
  end if;
  update public.blog_posts set prepared_action = p_action, prepared_revision = revision
  where id = p_post_id returning * into v_post;
  return jsonb_build_object('id',v_post.id,'revision',v_post.revision,'title',v_post.title,'slug',v_post.slug,
    'excerpt',v_post.excerpt,'document',v_post.document,'coverMediaId',v_post.cover_media_id,
    'serviceId',v_post.service_id,'preparedAction',v_post.prepared_action,'preparedRevision',v_post.prepared_revision,
    'contentModifiedAt',v_post.content_modified_at,'firstConfirmedAt',v_post.first_confirmed_at);
end;
$$;

create or replace function public.blog_freeze_release(p_request_id uuid, p_generation bigint, p_session_id uuid, p_expected_digest text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, blog_private, public, auth, extensions
as $$
declare
  v_owner_id uuid;
  v_existing blog_private.publication_requests%rowtype;
  v_summary jsonb;
  v_changes jsonb;
  v_base_release_id uuid;
  v_release_id uuid;
  v_confirmed_at timestamptz := clock_timestamp();
  v_posts jsonb;
  v_payload_text text;
  v_payload_digest text;
  v_expected_upserts bigint;
  v_actual_upserts bigint;
  v_change_count bigint;
  v_consumed_count bigint;
begin
  v_owner_id := blog_private.assert_admin_session(p_session_id,p_generation);
  if p_request_id is null or p_expected_digest is null or p_expected_digest !~ '^[a-f0-9]{64}$' then
    raise exception 'publication request identity and digest are required' using errcode = '22023';
  end if;

  -- Lock order: session, build slot, request, then prepared posts sorted by UUID.
  perform 1 from blog_private.build_slot where singleton for update;
  perform blog_private.revalidate_admin_session(p_session_id, p_generation, v_owner_id);
  select * into v_existing from blog_private.publication_requests where request_id = p_request_id for update;
  if found then
    perform blog_private.revalidate_admin_session(p_session_id, p_generation, v_owner_id);
    if v_existing.owner_id <> v_owner_id or v_existing.expected_summary_digest <> p_expected_digest then
      raise exception 'request id was already used with different publication input' using errcode = '40001';
    end if;
    select r.payload_text, r.digest into v_payload_text, v_payload_digest
    from blog_private.releases r where r.release_id = v_existing.release_id;
    return jsonb_build_object('releaseId',v_existing.release_id,'payload',v_payload_text,'digest',v_payload_digest);
  end if;

  perform p.id from public.blog_posts p
  where p.owner_id = v_owner_id and p.prepared_action is not null
  order by p.id for update;

  perform blog_private.revalidate_admin_session(p_session_id, p_generation, v_owner_id);
  v_summary := blog_private.current_publication_summary(v_owner_id);
  if v_summary ->> 'digest' is distinct from p_expected_digest then
    raise exception 'publication summary is stale' using errcode = '40001';
  end if;
  v_changes := v_summary -> 'changes';
  v_change_count := jsonb_array_length(v_changes);
  if v_change_count = 0 then
    raise exception 'there are no prepared changes to confirm' using errcode = '22023';
  end if;
  select count(*) into v_expected_upserts
  from jsonb_to_recordset(v_changes) as c("postId" uuid, revision bigint, action text)
  where c.action = 'upsert';

  select b.latest_confirmed_release_id into v_base_release_id
  from blog_private.build_slot b where b.singleton;
  if v_base_release_id is null then raise exception 'confirmed base release is missing' using errcode = '55000'; end if;

  with change_set as (
    select c."postId", c.revision, c.action
    from jsonb_to_recordset(v_changes) as c("postId" uuid, revision bigint, action text)
  ), base_posts as (
    select value as post from blog_private.releases r
    cross join lateral jsonb_array_elements(r.payload_text::jsonb -> 'posts')
    where r.release_id = v_base_release_id
  ), retained as (
    select b.post from base_posts b
    where not exists (
      select 1 from change_set c where c."postId"::text = b.post ->> 'id'
    )
  ), upserts as (
    select blog_private.public_post_json(p, v_confirmed_at) as post
    from public.blog_posts p
    join change_set c on c."postId" = p.id and c.action = 'upsert'
    where p.owner_id = v_owner_id and p.revision = c.revision
      and p.prepared_action = c.action and p.prepared_revision = c.revision
  ), combined as (
    select post from retained union all select post from upserts
  )
  select coalesce(jsonb_agg(post order by post ->> 'publishedAt' desc, post ->> 'slug' asc), '[]'::jsonb)
  into v_posts from combined;

  select count(*) into v_actual_upserts
  from jsonb_array_elements(v_posts) as p(value)
  join jsonb_to_recordset(v_changes) as c("postId" uuid, revision bigint, action text)
    on c.action = 'upsert' and p.value ->> 'id' = c."postId"::text;
  if v_actual_upserts <> v_expected_upserts then
    raise exception 'prepared publication set changed during composition' using errcode = '40001';
  end if;

  v_release_id := extensions.gen_random_uuid();
  v_payload_text := jsonb_build_object('schemaVersion',1,'releaseId',v_release_id,'posts',v_posts)::text;
  v_payload_digest := encode(extensions.digest(convert_to(v_payload_text,'UTF8'),'sha256'),'hex');

  insert into blog_private.releases (release_id, base_release_id, payload_text, digest)
  values (v_release_id, v_base_release_id, v_payload_text, v_payload_digest);
  insert into blog_private.publication_requests (request_id, owner_id, release_id, expected_summary_digest)
  values (p_request_id, v_owner_id, v_release_id, p_expected_digest);
  update blog_private.build_slot set latest_confirmed_release_id = v_release_id, generation = generation + 1, updated_at = v_confirmed_at
  where singleton;

  update public.blog_posts p set
    first_confirmed_at = case when c.action = 'upsert' then coalesce(p.first_confirmed_at, v_confirmed_at) else p.first_confirmed_at end,
    prepared_action = null,
    prepared_revision = null
  from jsonb_to_recordset(v_changes) as c("postId" uuid, revision bigint, action text)
  where p.id = c."postId" and p.owner_id = v_owner_id
    and p.revision = c.revision and p.prepared_revision = c.revision and p.prepared_action = c.action;
  get diagnostics v_consumed_count = row_count;
  if v_consumed_count <> v_change_count then
    raise exception 'prepared publication set changed before consumption' using errcode = '40001';
  end if;

  return jsonb_build_object('releaseId',v_release_id,'payload',v_payload_text,'digest',v_payload_digest);
end;
$$;
