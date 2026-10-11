create extension if not exists pgcrypto with schema extensions;

create schema blog_private;
revoke all on schema blog_private from public, anon, authenticated, service_role;
grant usage on schema blog_private to authenticated;

create table blog_private.settings (
  singleton boolean primary key default true check (singleton),
  authorized_owner_id uuid,
  updated_at timestamptz not null default clock_timestamp()
);

insert into blog_private.settings (singleton, authorized_owner_id) values (true, null);

create table blog_private.admin_sessions (
  session_id uuid primary key,
  user_id uuid not null,
  generation bigint not null check (generation > 0),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default clock_timestamp()
);

create index admin_sessions_user_id_idx on blog_private.admin_sessions (user_id, expires_at desc);

create table public.blog_media (
  id text primary key check (length(id) between 1 and 128),
  owner_id uuid not null,
  state text not null check (state in ('uploading', 'complete')),
  pipeline_version integer not null check (pipeline_version = 1),
  variants jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default clock_timestamp(),
  check (jsonb_typeof(variants) = 'array'),
  check (state <> 'complete' or jsonb_array_length(variants) > 0)
);

create index blog_media_owner_idx on public.blog_media (owner_id, id);

create table public.blog_posts (
  id uuid primary key default extensions.gen_random_uuid(),
  owner_id uuid not null,
  revision bigint not null default 1 check (revision > 0),
  title text not null default '' check (char_length(title) <= 160),
  slug text not null default '' check (char_length(slug) <= 120 and (slug = '' or slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$')),
  excerpt text not null default '' check (char_length(excerpt) <= 320),
  document jsonb not null default '{"type":"doc","content":[]}'::jsonb,
  cover_media_id text,
  service_id integer check (service_id between 1 and 6),
  prepared_action text check (prepared_action in ('upsert', 'remove')),
  prepared_revision bigint,
  content_modified_at timestamptz not null default clock_timestamp(),
  first_confirmed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  check ((prepared_action is null) = (prepared_revision is null)),
  check (prepared_revision is null or prepared_revision <= revision),
  check (jsonb_typeof(document) = 'object'),
  check (octet_length(document::text) <= 262144)
);

create unique index blog_posts_slug_unique on public.blog_posts (slug) where slug <> '';
create index blog_posts_owner_idx on public.blog_posts (owner_id, id);
create index blog_posts_prepared_idx on public.blog_posts (owner_id, prepared_action, id) where prepared_action is not null;

create table blog_private.releases (
  release_id uuid primary key,
  base_release_id uuid references blog_private.releases (release_id) on delete restrict,
  payload_text text not null,
  digest text not null check (digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  check (jsonb_typeof(payload_text::jsonb) = 'object')
);

create index releases_created_idx on blog_private.releases (created_at desc, release_id desc);

create table blog_private.publication_requests (
  request_id uuid primary key,
  owner_id uuid not null,
  release_id uuid not null unique references blog_private.releases (release_id) on delete restrict,
  expected_summary_digest text not null check (expected_summary_digest ~ '^[a-f0-9]{64}$'),
  state text not null default 'confirmed' check (state in ('confirmed', 'queued', 'building', 'live', 'failed', 'unknown')),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);

create table blog_private.build_slot (
  singleton boolean primary key default true check (singleton),
  latest_confirmed_release_id uuid references blog_private.releases (release_id) on delete restrict,
  active_request_id uuid references blog_private.publication_requests (request_id) on delete restrict,
  generation bigint not null default 0 check (generation >= 0),
  updated_at timestamptz not null default clock_timestamp()
);

create index publication_requests_owner_idx on blog_private.publication_requests (owner_id, created_at desc);

create or replace function blog_private.document_node_valid(p_node jsonb, p_parent text, p_depth integer default 0)
returns boolean
language plpgsql
immutable
set search_path = pg_catalog
as $$
declare
  v_type text;
  v_key text;
  v_href text;
  v_child jsonb;
  v_mark jsonb;
  v_mark_type text;
  v_mark_types text[] := array[]::text[];
  v_allowed_keys text[];
  v_allowed_children text[];
begin
  if p_depth > 32 then return false; end if;
  if jsonb_typeof(p_node) is distinct from 'object' then return false; end if;
  v_type := p_node ->> 'type';
  if v_type is null then return false; end if;

  case v_type
    when 'doc' then
      if p_parent is not null then return false; end if;
      v_allowed_keys := array['type', 'content'];
      v_allowed_children := array['paragraph', 'heading', 'bulletList', 'orderedList', 'image'];
    when 'paragraph' then
      v_allowed_keys := array['type', 'content']; v_allowed_children := array['text', 'hardBreak'];
    when 'heading' then
      v_allowed_keys := array['type', 'attrs', 'content']; v_allowed_children := array['text', 'hardBreak'];
      if jsonb_typeof(p_node -> 'attrs') is distinct from 'object' then return false; end if;
      if (select count(*) from jsonb_object_keys(p_node -> 'attrs')) <> 1 then return false; end if;
      if jsonb_typeof(p_node #> '{attrs,level}') is distinct from 'number' then return false; end if;
      if (p_node #>> '{attrs,level}')::numeric not in (2, 3) then return false; end if;
    when 'bulletList', 'orderedList' then
      v_allowed_keys := array['type', 'content']; v_allowed_children := array['listItem'];
    when 'listItem' then
      v_allowed_keys := array['type', 'content']; v_allowed_children := array['paragraph', 'bulletList', 'orderedList'];
    when 'text' then
      v_allowed_keys := array['type', 'text', 'marks']; v_allowed_children := array[]::text[];
      if jsonb_typeof(p_node -> 'text') is distinct from 'string' or length(btrim(p_node ->> 'text')) = 0 then return false; end if;
      if p_node ? 'marks' then
        if jsonb_typeof(p_node -> 'marks') <> 'array' then return false; end if;
        for v_mark in select value from jsonb_array_elements(p_node -> 'marks') loop
          if jsonb_typeof(v_mark) is distinct from 'object' then return false; end if;
          v_mark_type := v_mark ->> 'type';
          if v_mark_type is null or v_mark_type = any(v_mark_types) then return false; end if;
          v_mark_types := array_append(v_mark_types, v_mark_type);
          if v_mark_type in ('bold', 'italic') then
            if (select count(*) from jsonb_object_keys(v_mark)) <> 1 then return false; end if;
          elsif v_mark_type = 'link' then
            if (select count(*) from jsonb_object_keys(v_mark)) <> 2
              or jsonb_typeof(v_mark -> 'attrs') is distinct from 'object' then return false; end if;
            if (select count(*) from jsonb_object_keys(v_mark -> 'attrs')) <> 1
              or jsonb_typeof(v_mark #> '{attrs,href}') is distinct from 'string' then return false; end if;
            v_href := v_mark #>> '{attrs,href}';
            if v_href is null or v_href = '' or v_href ~ '[[:space:][:cntrl:]\\]' then return false; end if;
            if left(v_href, 1) = '/' then
              if left(v_href, 2) = '//' then return false; end if;
            elsif v_href !~* '^https?://[^/@?#]+([/?#].*)?$'
              and v_href !~* '^mailto:[^/?#@]+@[^/?#@]+([?#].*)?$'
              and v_href !~* '^tel:\+?[0-9().-]+$' then
              return false;
            end if;
          else
            return false;
          end if;
        end loop;
      end if;
    when 'hardBreak' then
      v_allowed_keys := array['type']; v_allowed_children := array[]::text[];
    when 'image' then
      v_allowed_keys := array['type', 'attrs']; v_allowed_children := array[]::text[];
      if jsonb_typeof(p_node -> 'attrs') is distinct from 'object' then return false; end if;
      if exists (select 1 from jsonb_object_keys(p_node -> 'attrs') k where k not in ('mediaId', 'alt', 'caption'))
        or not ((p_node -> 'attrs') ? 'mediaId') or not ((p_node -> 'attrs') ? 'alt')
        or jsonb_typeof(p_node #> '{attrs,mediaId}') <> 'string'
        or jsonb_typeof(p_node #> '{attrs,alt}') <> 'string'
        or ((p_node -> 'attrs') ? 'caption' and jsonb_typeof(p_node #> '{attrs,caption}') <> 'string')
        or length(btrim(p_node #>> '{attrs,mediaId}')) = 0
        or length(btrim(p_node #>> '{attrs,alt}')) = 0
        or char_length(p_node #>> '{attrs,mediaId}') > 128
        or char_length(p_node #>> '{attrs,alt}') > 500
        or char_length(coalesce(p_node #>> '{attrs,caption}', '')) > 500 then return false; end if;
    else
      return false;
  end case;

  for v_key in select jsonb_object_keys(p_node) loop
    if not (v_key = any(v_allowed_keys)) then return false; end if;
  end loop;
  if p_node ? 'content' then
    if jsonb_typeof(p_node -> 'content') <> 'array' then return false; end if;
    for v_child in select value from jsonb_array_elements(p_node -> 'content') loop
      if not ((v_child ->> 'type') = any(v_allowed_children)) then return false; end if;
      if not blog_private.document_node_valid(v_child, v_type, p_depth + 1) then return false; end if;
    end loop;
  elsif v_type in ('doc', 'paragraph', 'heading', 'bulletList', 'orderedList', 'listItem') then
    return false;
  end if;
  if v_type = 'text' and (jsonb_typeof(p_node -> 'text') is distinct from 'string' or char_length(p_node ->> 'text') > 262144) then return false; end if;
  return true;
end;
$$;

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

create or replace function blog_private.document_has_text(p_document jsonb)
returns boolean
language sql
immutable
set search_path = pg_catalog
as $$
  with recursive nodes(node) as (
    select p_document
    union all
    select child.value
    from nodes n
    cross join lateral jsonb_array_elements(case when jsonb_typeof(n.node -> 'content') = 'array' then n.node -> 'content' else '[]'::jsonb end) as child(value)
  )
  select exists(select 1 from nodes where node ->> 'type' = 'text');
$$;

create or replace function blog_private.document_media_ids(p_document jsonb)
returns table(media_id text)
language sql
immutable
set search_path = pg_catalog
as $$
  with recursive nodes(node) as (
    select p_document
    union all
    select child.value
    from nodes n
    cross join lateral jsonb_array_elements(case when jsonb_typeof(n.node -> 'content') = 'array' then n.node -> 'content' else '[]'::jsonb end) as child(value)
  )
  select distinct n.node #>> '{attrs,mediaId}'
  from nodes n
  where n.node ->> 'type' = 'image'
$$;

create or replace function blog_private.authorized_owner(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, blog_private, auth
as $$
  select p_user_id is not null
    and p_user_id = (select auth.uid())
    and exists (select 1 from blog_private.settings s where s.singleton and s.authorized_owner_id = p_user_id);
$$;

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

  if v_user_id is null or v_user_id is distinct from (select auth.uid())
    or not exists (select 1 from blog_private.settings s where s.singleton and s.authorized_owner_id = v_user_id) then
    raise exception 'editor authorization is required' using errcode = '42501';
  end if;
  return v_user_id;
end;
$$;

create or replace function blog_private.media_group_valid(p_media_id text, p_owner_id uuid)
returns boolean
language plpgsql
stable
set search_path = pg_catalog, public
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
    if v_width <> trunc(v_width) or v_width < 1 or v_width > 12000
      or v_height <> trunc(v_height) or v_height < 1 or v_height > 12000
      or v_width * v_height > 60000000
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

create or replace function blog_private.ready_post_valid(p_post public.blog_posts)
returns boolean
language plpgsql
stable
set search_path = pg_catalog, blog_private, public
as $$
declare
  v_media_id text;
begin
  if p_post.title = '' or p_post.slug = '' or p_post.excerpt = ''
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

create or replace function blog_private.current_publication_summary(p_owner_id uuid)
returns jsonb
language plpgsql
stable
set search_path = pg_catalog, blog_private, public, extensions
as $$
declare
  v_base_release_id uuid;
  v_changes jsonb;
  v_summary jsonb;
begin
  select b.latest_confirmed_release_id into v_base_release_id
  from blog_private.build_slot b where b.singleton;

  select coalesce(jsonb_agg(jsonb_build_object('postId', p.id, 'revision', p.revision, 'action', p.prepared_action) order by p.id), '[]'::jsonb)
  into v_changes
  from public.blog_posts p
  where p.owner_id = p_owner_id
    and p.prepared_action is not null
    and p.prepared_revision = p.revision;

  v_summary := jsonb_build_object('baseReleaseId', v_base_release_id, 'changes', v_changes);
  return v_summary || jsonb_build_object('digest', encode(extensions.digest(convert_to(v_summary::text, 'UTF8'), 'sha256'), 'hex'));
end;
$$;

create or replace function blog_private.public_post_json(p_post public.blog_posts, p_confirmed_at timestamptz)
returns jsonb
language sql
stable
set search_path = pg_catalog, blog_private, public
as $$
  select jsonb_build_object(
    'id', p_post.id,
    'slug', p_post.slug,
    'title', p_post.title,
    'excerpt', p_post.excerpt,
    'document', p_post.document,
    'coverMedia', (select jsonb_build_object('id', m.id, 'variants', m.variants) from public.blog_media m where m.id = p_post.cover_media_id),
    'media', coalesce((
      select jsonb_agg(jsonb_build_object('id', m.id, 'variants', m.variants) order by m.id)
      from public.blog_media m
      where m.id in (select media_id from blog_private.document_media_ids(p_post.document))
        and m.owner_id = p_post.owner_id
    ), '[]'::jsonb),
    'serviceId', p_post.service_id,
    'publishedAt', coalesce(p_post.first_confirmed_at, p_confirmed_at),
    'modifiedAt', p_post.content_modified_at
  );
$$;

create or replace function blog_private.touch_editorial_post()
returns trigger
language plpgsql
set search_path = pg_catalog, blog_private
as $$
begin
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

create trigger blog_posts_touch_before_write
before insert or update on public.blog_posts
for each row execute function blog_private.touch_editorial_post();

create or replace function blog_private.reject_release_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  raise exception 'release snapshots are immutable' using errcode = '55000';
end;
$$;

create trigger releases_immutable_before_update_or_delete
before update or delete on blog_private.releases
for each row execute function blog_private.reject_release_mutation();

create or replace function blog_private.save_post(p_input jsonb, p_expected_revision bigint, p_session_id uuid, p_generation bigint)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, blog_private, public, auth, extensions
as $$
declare
  v_owner_id uuid;
  v_post_id uuid;
  v_existing public.blog_posts%rowtype;
  v_result public.blog_posts%rowtype;
begin
  v_owner_id := blog_private.assert_admin_session(p_session_id, p_generation);
  if p_expected_revision is null then raise exception 'expected revision is required' using errcode = '22023'; end if;
  if p_input is null or jsonb_typeof(p_input) is distinct from 'object' then
    raise exception 'draft must be a JSON object' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_object_keys(p_input) k where k not in ('id','title','slug','excerpt','document','coverMediaId','serviceId')) then
    raise exception 'draft contains unsupported fields' using errcode = '22023';
  end if;
  if (p_input ? 'title' and jsonb_typeof(p_input -> 'title') <> 'string')
    or (p_input ? 'slug' and jsonb_typeof(p_input -> 'slug') <> 'string')
    or (p_input ? 'excerpt' and jsonb_typeof(p_input -> 'excerpt') <> 'string')
    or (p_input ? 'coverMediaId' and p_input -> 'coverMediaId' <> 'null'::jsonb
      and jsonb_typeof(p_input -> 'coverMediaId') <> 'string')
    or (p_input ? 'serviceId' and p_input -> 'serviceId' <> 'null'::jsonb
      and jsonb_typeof(p_input -> 'serviceId') <> 'number') then
    raise exception 'draft field types are invalid' using errcode = '22023';
  end if;
  if not blog_private.document_v1_valid(coalesce(p_input -> 'document', '{"type":"doc","content":[]}'::jsonb)) then
    raise exception 'DocumentV1 is invalid' using errcode = '22023';
  end if;
  if char_length(btrim(coalesce(p_input ->> 'title', ''))) > 160
    or char_length(btrim(coalesce(p_input ->> 'slug', ''))) > 120
    or (coalesce(p_input ->> 'slug', '') <> '' and coalesce(p_input ->> 'slug', '') !~ '^[a-z0-9]+(-[a-z0-9]+)*$')
    or char_length(btrim(coalesce(p_input ->> 'excerpt', ''))) > 320 then
    raise exception 'draft fields exceed their limits' using errcode = '22023';
  end if;
  if p_input ? 'serviceId' and p_input -> 'serviceId' <> 'null'::jsonb
    and ((p_input ->> 'serviceId')::numeric <> trunc((p_input ->> 'serviceId')::numeric)
      or (p_input ->> 'serviceId')::numeric not between 1 and 6) then
    raise exception 'serviceId is invalid' using errcode = '22023';
  end if;
  if p_input ? 'coverMediaId' and p_input -> 'coverMediaId' <> 'null'::jsonb
    and char_length(p_input ->> 'coverMediaId') > 128 then
    raise exception 'coverMediaId is invalid' using errcode = '22023';
  end if;

  if p_input ? 'id' then
    begin v_post_id := (p_input ->> 'id')::uuid;
    exception when others then raise exception 'post id is invalid' using errcode = '22023'; end;
    select * into v_existing from public.blog_posts where id = v_post_id for update;
    if not found or v_existing.owner_id <> v_owner_id then raise exception 'post is unavailable' using errcode = '42501'; end if;
    if v_existing.revision <> p_expected_revision then raise exception 'post revision is stale' using errcode = '40001'; end if;
    update public.blog_posts set
      title = btrim(coalesce(p_input ->> 'title', '')),
      slug = btrim(coalesce(p_input ->> 'slug', '')),
      excerpt = btrim(coalesce(p_input ->> 'excerpt', '')),
      document = coalesce(p_input -> 'document', '{"type":"doc","content":[]}'::jsonb),
      cover_media_id = nullif(btrim(p_input ->> 'coverMediaId'), ''),
      service_id = nullif(p_input ->> 'serviceId', '')::integer
    where id = v_post_id returning * into v_result;
  else
    if p_expected_revision <> 0 then raise exception 'new post revision must be zero' using errcode = '40001'; end if;
    insert into public.blog_posts (owner_id, title, slug, excerpt, document, cover_media_id, service_id)
    values (v_owner_id, btrim(coalesce(p_input ->> 'title', '')), btrim(coalesce(p_input ->> 'slug', '')),
      btrim(coalesce(p_input ->> 'excerpt', '')), coalesce(p_input -> 'document', '{"type":"doc","content":[]}'::jsonb),
      nullif(btrim(p_input ->> 'coverMediaId'), ''), nullif(p_input ->> 'serviceId', '')::integer)
    returning * into v_result;
  end if;

  return jsonb_build_object('id',v_result.id,'revision',v_result.revision,'title',v_result.title,'slug',v_result.slug,
    'excerpt',v_result.excerpt,'document',v_result.document,'coverMediaId',v_result.cover_media_id,
    'serviceId',v_result.service_id,'preparedAction',v_result.prepared_action,'preparedRevision',v_result.prepared_revision,
    'contentModifiedAt',v_result.content_modified_at,'firstConfirmedAt',v_result.first_confirmed_at);
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
  select * into v_post from public.blog_posts where id = p_post_id and owner_id = v_owner_id for update;
  if not found then raise exception 'post is unavailable' using errcode = '42501'; end if;
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

create or replace function public.blog_save_post(p_input jsonb, p_expected_revision bigint, p_session_id uuid, p_generation bigint)
returns jsonb language sql security definer
set search_path = pg_catalog, blog_private, public, auth, extensions
as $$ select blog_private.save_post(p_input,p_expected_revision,p_session_id,p_generation); $$;

create or replace function public.blog_mark_prepared(p_post_id uuid, p_expected_revision bigint, p_action text, p_session_id uuid, p_generation bigint)
returns jsonb language sql security definer
set search_path = pg_catalog, blog_private, public, auth, extensions
as $$ select blog_private.mark_prepared(p_post_id,p_expected_revision,p_action,p_session_id,p_generation); $$;

create or replace function public.blog_publication_summary(p_session_id uuid, p_generation bigint)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, blog_private, public, auth
as $$
declare v_owner_id uuid;
begin
  v_owner_id := blog_private.assert_admin_session(p_session_id,p_generation);
  return blog_private.current_publication_summary(v_owner_id);
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
  select * into v_existing from blog_private.publication_requests where request_id = p_request_id for update;
  if found then
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

alter table public.blog_posts enable row level security;
alter table public.blog_media enable row level security;
alter table blog_private.settings enable row level security;
alter table blog_private.admin_sessions enable row level security;
alter table blog_private.releases enable row level security;
alter table blog_private.publication_requests enable row level security;
alter table blog_private.build_slot enable row level security;

create policy blog_posts_owner_select on public.blog_posts for select to authenticated
using ((select blog_private.authorized_owner(owner_id)));
create policy blog_media_owner_select on public.blog_media for select to authenticated
using ((select blog_private.authorized_owner(owner_id)));

revoke all on table public.blog_posts, public.blog_media from public, anon, authenticated, service_role;
grant select on table public.blog_posts, public.blog_media to authenticated;
revoke all on all tables in schema blog_private from public, anon, authenticated, service_role;
revoke all on all functions in schema blog_private from public, anon, authenticated, service_role;
revoke execute on function public.blog_save_post(jsonb,bigint,uuid,bigint) from public, anon, authenticated, service_role;
revoke execute on function public.blog_mark_prepared(uuid,bigint,text,uuid,bigint) from public, anon, authenticated, service_role;
revoke execute on function public.blog_publication_summary(uuid,bigint) from public, anon, authenticated, service_role;
revoke execute on function public.blog_freeze_release(uuid,bigint,uuid,text) from public, anon, authenticated, service_role;
grant execute on function blog_private.authorized_owner(uuid) to authenticated;

grant execute on function public.blog_save_post(jsonb,bigint,uuid,bigint) to authenticated;
grant execute on function public.blog_mark_prepared(uuid,bigint,text,uuid,bigint) to authenticated;
grant execute on function public.blog_publication_summary(uuid,bigint) to authenticated;
grant execute on function public.blog_freeze_release(uuid,bigint,uuid,text) to authenticated;

insert into blog_private.build_slot (singleton) values (true);

do $$
declare
  v_release_id uuid := '00000000-0000-0000-0000-000000000001';
  v_payload text;
  v_digest text;
begin
  v_payload := jsonb_build_object('schemaVersion',1,'releaseId',v_release_id,'posts','[]'::jsonb)::text;
  v_digest := encode(extensions.digest(convert_to(v_payload,'UTF8'),'sha256'),'hex');
  insert into blog_private.releases (release_id, base_release_id, payload_text, digest)
  values (v_release_id, null, v_payload, v_digest);
  update blog_private.build_slot set latest_confirmed_release_id = v_release_id where singleton;
end;
$$;
