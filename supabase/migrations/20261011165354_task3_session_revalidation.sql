create or replace function blog_private.revalidate_admin_session(p_session_id uuid, p_generation bigint, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, blog_private, auth
as $$
begin
  if p_user_id is null or p_user_id is distinct from (select auth.uid())
    or not exists (
      select 1 from blog_private.admin_sessions s
      where s.session_id = p_session_id
        and s.user_id = p_user_id
        and s.generation = p_generation
        and s.revoked_at is null
        and s.expires_at > clock_timestamp()
    )
    or not exists (
      select 1 from blog_private.settings s
      where s.singleton and s.authorized_owner_id = p_user_id
    ) then
    raise exception 'editor authorization is required' using errcode = '42501';
  end if;
end;
$$;
revoke all on function blog_private.revalidate_admin_session(uuid,bigint,uuid) from public, anon, authenticated, service_role;

create or replace function blog_private.assert_admin_session(p_session_id uuid, p_generation bigint)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, blog_private, auth
as $$
declare
  v_user_id uuid;
begin
  select s.user_id into v_user_id
  from blog_private.admin_sessions s
  where s.session_id = p_session_id
    and s.generation = p_generation
    and s.revoked_at is null
    and s.expires_at > clock_timestamp()
  for share;

  perform blog_private.revalidate_admin_session(p_session_id, p_generation, v_user_id);
  perform set_config('blog.editorial_session_id', p_session_id::text, true);
  perform set_config('blog.editorial_session_generation', p_generation::text, true);
  perform set_config('blog.editorial_user_id', v_user_id::text, true);
  return v_user_id;
end;
$$;

create or replace function blog_private.touch_editorial_post()
returns trigger
language plpgsql
set search_path = pg_catalog, blog_private
as $$
declare
  v_session_id text := current_setting('blog.editorial_session_id', true);
  v_generation text := current_setting('blog.editorial_session_generation', true);
  v_user_id text := current_setting('blog.editorial_user_id', true);
begin
  if v_session_id is not null or v_generation is not null or v_user_id is not null then
    if v_session_id is null or v_generation is null or v_user_id is null then
      raise exception 'editor authorization is required' using errcode = '42501';
    end if;
    perform blog_private.revalidate_admin_session(v_session_id::uuid, v_generation::bigint, v_user_id::uuid);
  end if;

  if tg_op = 'UPDATE' then
    if new.id is distinct from old.id or new.owner_id is distinct from old.owner_id then
      raise exception 'post identity is immutable' using errcode = '23514';
    end if;
    if old.first_confirmed_at is not null and new.slug is distinct from old.slug then
      raise exception 'confirmed slug is immutable' using errcode = '23514';
    end if;
    if row(new.title, new.slug, new.excerpt, new.document, new.cover_media_id, new.service_id)
      is distinct from row(old.title, old.slug, old.excerpt, old.document, old.cover_media_id, old.service_id) then
      if not blog_private.document_v1_valid(new.document) then
        raise exception 'DocumentV1 is invalid' using errcode = '22023';
      end if;
      new.revision := old.revision + 1;
      new.content_modified_at := clock_timestamp();
      new.prepared_action := null;
      new.prepared_revision := null;
    else
      new.revision := old.revision;
      new.content_modified_at := old.content_modified_at;
    end if;
  elsif not blog_private.document_v1_valid(new.document) then
    raise exception 'DocumentV1 is invalid' using errcode = '22023';
  end if;
  return new;
end;
$$;

create or replace function blog_private.media_group_valid(p_media_id text, p_owner_id uuid)
returns boolean
language plpgsql
stable
set search_path = pg_catalog, blog_private, public
as $$
declare
  v_media public.blog_media%rowtype;
  v_variant jsonb;
  v_width numeric;
  v_height numeric;
  v_byte_length numeric;
  v_widths numeric[] := array[]::numeric[];
begin
  select * into v_media from public.blog_media m
  where m.id = p_media_id and m.owner_id = p_owner_id
    and m.state = 'complete' and m.pipeline_version = 1;
  if not found or jsonb_typeof(v_media.variants) <> 'array' or jsonb_array_length(v_media.variants) = 0 then return false; end if;
  for v_variant in select value from jsonb_array_elements(v_media.variants) loop
    if jsonb_typeof(v_variant) is distinct from 'object' then return false; end if;
    if (select count(*) from jsonb_object_keys(v_variant)) <> 6
      or exists (select 1 from jsonb_object_keys(v_variant) k where k not in ('width','height','mime','byteLength','sha256','objectKey'))
      or not (v_variant ?& array['width','height','mime','byteLength','sha256','objectKey'])
      or jsonb_typeof(v_variant -> 'width') <> 'number'
      or jsonb_typeof(v_variant -> 'height') <> 'number'
      or jsonb_typeof(v_variant -> 'byteLength') <> 'number'
      or jsonb_typeof(v_variant -> 'mime') <> 'string'
      or jsonb_typeof(v_variant -> 'sha256') <> 'string'
      or jsonb_typeof(v_variant -> 'objectKey') <> 'string' then return false; end if;
    v_width := (v_variant ->> 'width')::numeric;
    v_height := (v_variant ->> 'height')::numeric;
    v_byte_length := (v_variant ->> 'byteLength')::numeric;
    if v_width <> trunc(v_width) or v_width < 1 or v_width > 1600
      or v_height <> trunc(v_height) or v_height < 1 or v_height > 1600
      or v_byte_length <> trunc(v_byte_length) or v_byte_length < 1 or v_byte_length > 1048576
      or v_width = any(v_widths)
      or v_variant ->> 'mime' <> 'image/webp'
      or v_variant ->> 'sha256' !~ '^[a-f0-9]{64}$'
      or v_variant ->> 'objectKey' not like 'public/%' then return false; end if;
    v_widths := array_append(v_widths, v_width);
  end loop;
  return true;
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
  v_base_release_id uuid;
  v_release_id uuid;
  v_confirmed_at timestamptz := clock_timestamp();
  v_posts jsonb;
  v_payload_text text;
  v_payload_digest text;
begin
  v_owner_id := blog_private.assert_admin_session(p_session_id,p_generation);
  if p_request_id is null or p_expected_digest is null or p_expected_digest !~ '^[a-f0-9]{64}$' then
    raise exception 'publication request identity and digest are required' using errcode = '22023';
  end if;

  -- Lock order: app session, shared build slot, request row, then post rows sorted by UUID.
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
  if jsonb_array_length(v_summary -> 'changes') = 0 then
    raise exception 'there are no prepared changes to confirm' using errcode = '22023';
  end if;
  select b.latest_confirmed_release_id into v_base_release_id
  from blog_private.build_slot b where b.singleton;
  if v_base_release_id is null then raise exception 'confirmed base release is missing' using errcode = '55000'; end if;

  with base_posts as (
    select value as post from blog_private.releases r
    cross join lateral jsonb_array_elements(r.payload_text::jsonb -> 'posts')
    where r.release_id = v_base_release_id
  ),
  retained as (
    select b.post from base_posts b
    where not exists (
      select 1 from public.blog_posts p
      where p.owner_id = v_owner_id and p.prepared_action is not null
        and p.id::text = b.post ->> 'id'
    )
  ),
  upserts as (
    select blog_private.public_post_json(p, v_confirmed_at) as post
    from public.blog_posts p
    where p.owner_id = v_owner_id and p.prepared_action = 'upsert'
      and p.prepared_revision = p.revision
  ), combined as (
    select post from retained union all select post from upserts
  )
  select coalesce(jsonb_agg(post order by post ->> 'publishedAt' desc, post ->> 'slug' asc), '[]'::jsonb)
  into v_posts from combined;
  v_release_id := extensions.gen_random_uuid();
  v_payload_text := jsonb_build_object('schemaVersion',1,'releaseId',v_release_id,'posts',v_posts)::text;
  v_payload_digest := encode(extensions.digest(convert_to(v_payload_text,'UTF8'),'sha256'),'hex');

  insert into blog_private.releases (release_id, base_release_id, payload_text, digest)
  values (v_release_id, v_base_release_id, v_payload_text, v_payload_digest);
  insert into blog_private.publication_requests (request_id, owner_id, release_id, expected_summary_digest)
  values (p_request_id, v_owner_id, v_release_id, p_expected_digest);
  update blog_private.build_slot set latest_confirmed_release_id = v_release_id, generation = generation + 1, updated_at = v_confirmed_at
  where singleton;

  update public.blog_posts set
    first_confirmed_at = case when prepared_action = 'upsert' then coalesce(first_confirmed_at, v_confirmed_at) else first_confirmed_at end,
    prepared_action = null,
    prepared_revision = null
  where owner_id = v_owner_id and prepared_action is not null and prepared_revision = revision;

  return jsonb_build_object('releaseId',v_release_id,'payload',v_payload_text,'digest',v_payload_digest);
end;
$$;
