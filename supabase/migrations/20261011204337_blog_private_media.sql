begin;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('blog-drafts', 'blog-drafts', false, 1048576, array['image/webp']),
  ('blog-public', 'blog-public', true, 1048576, array['image/webp'])
on conflict (id) do nothing;

do $$
begin
  if not exists (select 1 from storage.buckets where id = 'blog-drafts' and name = 'blog-drafts' and not public and file_size_limit = 1048576 and allowed_mime_types = array['image/webp'])
    or not exists (select 1 from storage.buckets where id = 'blog-public' and name = 'blog-public' and public and file_size_limit = 1048576 and allowed_mime_types = array['image/webp']) then
    raise exception 'blog media bucket configuration does not match the approved private/public contract';
  end if;
end;
$$;

create table blog_private.media_upload_intents (
  media_id text primary key,
  owner_id uuid not null,
  master_width integer not null check (master_width between 1 and 1600),
  master_height integer not null check (master_height between 1 and 1600),
  expected_widths integer[] not null check (cardinality(expected_widths) between 1 and 3),
  created_at timestamptz not null default clock_timestamp()
);
revoke all on blog_private.media_upload_intents from public, anon, authenticated, service_role;

create or replace function blog_private.blog_storage_request_authorized()
returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, blog_private, auth
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_session_id text := (select auth.jwt() ->> 'session_id');
  v_exp text := (select auth.jwt() ->> 'exp');
begin
  if v_user_id is null or v_session_id is null or v_exp is null or v_exp !~ '^[0-9]{1,16}$'
    or v_exp::bigint <= floor(extract(epoch from clock_timestamp()))::bigint then
    return false;
  end if;
  return exists (
    select 1
    from blog_private.settings setting
    join blog_private.admin_sessions app
      on app.user_id = setting.authorized_owner_id
    join auth.sessions provider
      on provider.id::text = app.auth_session_id::text and provider.user_id = app.user_id
    where setting.singleton and setting.authorized_owner_id = v_user_id
      and app.auth_session_id::text = v_session_id
      and app.revoked_at is null and app.expires_at > clock_timestamp()
      and app.auth_expires_at > clock_timestamp()
      and (provider.not_after is null or provider.not_after > clock_timestamp())
  );
end;
$$;
revoke all on function blog_private.blog_storage_request_authorized() from public, anon, authenticated, service_role;
grant execute on function blog_private.blog_storage_request_authorized() to authenticated;

drop policy if exists jt_blog_drafts_owner_select on storage.objects;
create policy jt_blog_drafts_owner_select on storage.objects for select to authenticated
using (
  bucket_id = 'blog-drafts'
  and (select blog_private.blog_storage_request_authorized())
  and owner_id = (select auth.uid()::text)
  and name ~ ('^draft/' || (select auth.uid()::text) || '/[0-9a-f-]{36}/[0-9]{1,4}\.webp$')
);

drop policy if exists jt_blog_drafts_owner_insert on storage.objects;
create policy jt_blog_drafts_owner_insert on storage.objects for insert to authenticated
with check (
  bucket_id = 'blog-drafts'
  and (select blog_private.blog_storage_request_authorized())
  and owner_id = (select auth.uid()::text)
  and name ~ ('^draft/' || (select auth.uid()::text) || '/[0-9a-f-]{36}/[0-9]{1,4}\.webp$')
);

create or replace function blog_private.media_admin_session_live(p_user_id uuid, p_session_id uuid, p_generation bigint)
returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, blog_private, auth
as $$
declare
  v_session blog_private.admin_sessions%rowtype;
begin
  select s.* into v_session from blog_private.admin_sessions s
  where s.session_id = p_session_id and s.user_id = p_user_id and s.generation = p_generation
  for update;
  if not found then return false; end if;
  return v_session.revoked_at is null
    and v_session.expires_at > clock_timestamp()
    and v_session.auth_expires_at > clock_timestamp()
    and exists (select 1 from blog_private.settings s where s.singleton and s.authorized_owner_id = p_user_id)
    and exists (
      select 1 from auth.sessions provider
      where provider.id = v_session.auth_session_id and provider.user_id = p_user_id
        and (provider.not_after is null or provider.not_after > clock_timestamp())
    );
end;
$$;
revoke all on function blog_private.media_admin_session_live(uuid,uuid,bigint) from public, anon, authenticated, service_role;

create or replace function blog_private.blog_media_revalidate_session(p_user_id uuid, p_session_id uuid, p_generation bigint)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, blog_private
as $$
begin
  if not blog_private.media_admin_session_live(p_user_id, p_session_id, p_generation) then
    raise exception 'editor authorization is required' using errcode = '42501';
  end if;
  return true;
end;
$$;

create or replace function public.blog_media_revalidate_session(p_user_id uuid, p_session_id uuid, p_generation bigint)
returns boolean
language sql
security definer
set search_path = pg_catalog, blog_private
as $$ select blog_private.blog_media_revalidate_session(p_user_id, p_session_id, p_generation) $$;

create or replace function blog_private.media_group_candidate_valid(p_media_id text, p_owner_id uuid)
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
  v_widths integer[] := array[]::integer[];
  v_max_width integer;
  v_max_height integer;
  v_expected integer[];
  v_intent blog_private.media_upload_intents%rowtype;
begin
  select * into v_media from public.blog_media m
  where m.id = p_media_id and m.owner_id = p_owner_id
    and m.pipeline_version = 1;
  if not found or jsonb_typeof(v_media.variants) <> 'array' or jsonb_array_length(v_media.variants) not between 1 and 3 then return false; end if;
  select * into v_intent from blog_private.media_upload_intents i where i.media_id = p_media_id and i.owner_id = p_owner_id;
  if not found then return false; end if;
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
      or v_width * v_height > 2560000
      or v_byte_length <> trunc(v_byte_length) or v_byte_length < 1 or v_byte_length > 1048576
      or v_width = any(v_widths)
      or v_variant ->> 'mime' <> 'image/webp'
      or v_variant ->> 'sha256' !~ '^[a-f0-9]{64}$'
      or v_variant ->> 'objectKey' <> 'public/' || p_media_id || '/' || (v_variant ->> 'width') || '-' || (v_variant ->> 'sha256') || '.webp' then return false; end if;
    v_widths := array_append(v_widths, v_width::integer);
    if v_max_width is null or v_width > v_max_width then
      v_max_width := v_width::integer;
      v_max_height := v_height::integer;
    end if;
  end loop;
  if v_widths <> (select array_agg(w order by w) from unnest(v_widths) as w)
    or v_widths <> v_intent.expected_widths
    or v_max_width <> v_intent.master_width or v_max_height <> v_intent.master_height then return false; end if;
  for v_variant in select value from jsonb_array_elements(v_media.variants) loop
    if (v_variant ->> 'height')::integer <> greatest(1, round(v_intent.master_height * (v_variant ->> 'width')::numeric / v_intent.master_width)::integer) then return false; end if;
  end loop;
  return true;
end;
$$;

create or replace function blog_private.media_group_valid(p_media_id text, p_owner_id uuid)
returns boolean
language sql
stable
set search_path = pg_catalog, public, blog_private
as $$
  select exists (select 1 from public.blog_media m where m.id = p_media_id and m.owner_id = p_owner_id and m.state = 'complete' and m.pipeline_version = 1)
    and blog_private.media_group_candidate_valid(p_media_id, p_owner_id)
$$;

create or replace function public.blog_media_record_variant(
  p_user_id uuid,
  p_session_id uuid,
  p_generation bigint,
  p_media_id text,
  p_variant jsonb
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, blog_private, public
as $$
declare
  v_session blog_private.admin_sessions%rowtype;
  v_existing public.blog_media%rowtype;
  v_intent blog_private.media_upload_intents%rowtype;
  v_width numeric;
  v_height numeric;
  v_byte_length numeric;
  v_sha text;
  v_expected integer[];
begin
  if p_user_id is null or p_session_id is null or p_generation is null or p_generation < 1 or p_media_id is null or p_variant is null
    or p_media_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or jsonb_typeof(p_variant) <> 'object'
    or (select count(*) from jsonb_object_keys(p_variant)) <> 6
    or exists (select 1 from jsonb_object_keys(p_variant) k where k not in ('width','height','mime','byteLength','sha256','objectKey'))
    or not (p_variant ?& array['width','height','mime','byteLength','sha256','objectKey'])
    or jsonb_typeof(p_variant -> 'width') <> 'number'
    or jsonb_typeof(p_variant -> 'height') <> 'number'
    or jsonb_typeof(p_variant -> 'byteLength') <> 'number'
    or jsonb_typeof(p_variant -> 'mime') <> 'string'
    or jsonb_typeof(p_variant -> 'sha256') <> 'string'
    or jsonb_typeof(p_variant -> 'objectKey') <> 'string' then
    raise exception 'media variant is invalid' using errcode = '22023';
  end if;
  v_width := (p_variant ->> 'width')::numeric;
  v_height := (p_variant ->> 'height')::numeric;
  v_byte_length := (p_variant ->> 'byteLength')::numeric;
  v_sha := p_variant ->> 'sha256';
  if v_width <> trunc(v_width) or v_width < 1 or v_width > 1600
    or v_height <> trunc(v_height) or v_height not between 1 and 1600
    or v_width * v_height > 2560000
    or v_byte_length <> trunc(v_byte_length) or v_byte_length not between 1 and 1048576
    or p_variant ->> 'mime' <> 'image/webp'
    or v_sha !~ '^[a-f0-9]{64}$'
    or p_variant ->> 'objectKey' <> 'public/' || p_media_id || '/' || (p_variant ->> 'width') || '-' || v_sha || '.webp' then
    raise exception 'media variant is invalid' using errcode = '22023';
  end if;

  select * into v_session from blog_private.admin_sessions s
  where s.session_id = p_session_id and s.user_id = p_user_id and s.generation = p_generation
  for update;
  if not found or not blog_private.media_admin_session_live(p_user_id, p_session_id, p_generation)
    or not exists (select 1 from blog_private.settings s where s.singleton and s.authorized_owner_id = p_user_id) then
    raise exception 'editor authorization is required' using errcode = '42501';
  end if;

  select * into v_existing from public.blog_media m where m.id = p_media_id for update;
  if not found then
    select array_agg(distinct width order by width) into v_expected
      from unnest(array[least(480, v_width::integer), least(960, v_width::integer), v_width::integer]) as widths(width);
    insert into blog_private.media_upload_intents(media_id, owner_id, master_width, master_height, expected_widths)
    values (p_media_id, p_user_id, v_width::integer, v_height::integer, v_expected)
    on conflict (media_id) do nothing;
    select * into v_intent from blog_private.media_upload_intents i where i.media_id = p_media_id for update;
    if not found or v_intent.owner_id <> p_user_id or v_intent.master_width <> v_width
      or v_intent.master_height <> v_height or v_intent.expected_widths <> v_expected then
      raise exception 'media master variant conflicts with the immutable group intent' using errcode = '23505';
    end if;
    insert into public.blog_media (id, owner_id, state, pipeline_version, variants)
    values (p_media_id, p_user_id, 'uploading', 1, '[]'::jsonb)
    on conflict (id) do nothing;
    select * into v_existing from public.blog_media m where m.id = p_media_id for update;
  else
    select * into v_intent from blog_private.media_upload_intents i where i.media_id = p_media_id for update;
    if not found then raise exception 'media group intent is missing' using errcode = '42501'; end if;
  end if;
  select * into v_existing from public.blog_media m where m.id = p_media_id for update;
  if not found then
    raise exception 'media group is not owned by this editor' using errcode = '42501';
  end if;
  if not blog_private.media_admin_session_live(p_user_id, p_session_id, p_generation)
    or not exists (select 1 from blog_private.settings s where s.singleton and s.authorized_owner_id = p_user_id) then
    raise exception 'editor authorization is required' using errcode = '42501';
  end if;
  if v_existing.owner_id <> p_user_id or v_existing.pipeline_version <> 1 then
    raise exception 'media group is not owned by this editor' using errcode = '42501';
  end if;
  if v_intent.owner_id <> p_user_id or not (v_width::integer = any(v_intent.expected_widths))
    or v_height::integer <> greatest(1, round(v_intent.master_height * v_width / v_intent.master_width)::integer) then
    raise exception 'media variant is outside the immutable master set' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(v_existing.variants) value where (value ->> 'width')::integer = v_width) then
    if exists (select 1 from jsonb_array_elements(v_existing.variants) value where (value ->> 'width')::integer = v_width and value = p_variant) then return true; end if;
    raise exception 'media variant is immutable' using errcode = '23505';
  end if;
  if v_existing.state <> 'uploading' then raise exception 'complete media is immutable' using errcode = '23505'; end if;
  update public.blog_media set variants = (
    select jsonb_agg(value order by (value ->> 'width')::integer)
    from jsonb_array_elements(v_existing.variants || jsonb_build_array(p_variant)) value
  ) where id = p_media_id;
  return true;
end;
$$;

create or replace function public.blog_media_complete(
  p_user_id uuid,
  p_session_id uuid,
  p_generation bigint,
  p_media_id text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, blog_private, public
as $$
declare
  v_session blog_private.admin_sessions%rowtype;
  v_media public.blog_media%rowtype;
begin
  if p_user_id is null or p_session_id is null or p_generation is null or p_generation < 1
    or p_media_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception 'media group is invalid' using errcode = '22023';
  end if;
  select * into v_session from blog_private.admin_sessions s
  where s.session_id = p_session_id and s.user_id = p_user_id and s.generation = p_generation
  for update;
  if not found or not blog_private.media_admin_session_live(p_user_id, p_session_id, p_generation)
    or not exists (select 1 from blog_private.settings s where s.singleton and s.authorized_owner_id = p_user_id) then
    raise exception 'editor authorization is required' using errcode = '42501';
  end if;
  select * into v_media from public.blog_media m where m.id = p_media_id for update;
  if not found then
    raise exception 'media group is not owned by this editor' using errcode = '42501';
  end if;
  if not blog_private.media_admin_session_live(p_user_id, p_session_id, p_generation)
    or not exists (select 1 from blog_private.settings s where s.singleton and s.authorized_owner_id = p_user_id) then
    raise exception 'editor authorization is required' using errcode = '42501';
  end if;
  if v_media.owner_id <> p_user_id or v_media.pipeline_version <> 1 then
    raise exception 'media group is not owned by this editor' using errcode = '42501';
  end if;
  if v_media.state = 'complete' then
    if not blog_private.media_group_valid(p_media_id, p_user_id) then raise exception 'complete media group is invalid' using errcode = '23514'; end if;
    return jsonb_build_object('id', v_media.id, 'state', v_media.state, 'variants', v_media.variants);
  end if;
  if not blog_private.media_group_candidate_valid(p_media_id, p_user_id) then
    raise exception 'media group is incomplete or invalid' using errcode = '22023';
  end if;
  update public.blog_media set state = 'complete' where id = p_media_id returning * into v_media;
  if not blog_private.media_group_valid(p_media_id, p_user_id) then
    raise exception 'media group is invalid after completion' using errcode = '23514';
  end if;
  return jsonb_build_object('id', v_media.id, 'state', v_media.state, 'variants', v_media.variants);
end;
$$;

create or replace function public.blog_media_promotion_manifest(
  p_user_id uuid,
  p_session_id uuid,
  p_generation bigint,
  p_media_ids text[]
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, blog_private, public
as $$
declare
  v_session blog_private.admin_sessions%rowtype;
  v_release jsonb;
  v_media jsonb;
  v_id text;
  v_result jsonb := '[]'::jsonb;
  v_count integer := 0;
begin
  if p_user_id is null or p_session_id is null or p_generation is null or p_generation < 1
    or p_media_ids is null or cardinality(p_media_ids) not between 1 and 100
    or exists (select 1 from unnest(p_media_ids) id where id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
    or cardinality(p_media_ids) <> (select count(distinct id) from unnest(p_media_ids) id) then
    raise exception 'media promotion request is invalid' using errcode = '22023';
  end if;
  select * into v_session from blog_private.admin_sessions s
  where s.session_id = p_session_id and s.user_id = p_user_id and s.generation = p_generation
  for update;
  if not found or not blog_private.media_admin_session_live(p_user_id, p_session_id, p_generation)
    or not exists (select 1 from blog_private.settings s where s.singleton and s.authorized_owner_id = p_user_id) then
    raise exception 'editor authorization is required' using errcode = '42501';
  end if;
  select r.payload_text::jsonb into v_release
  from blog_private.build_slot b join blog_private.releases r on r.release_id = b.latest_confirmed_release_id
  where b.singleton;
  if v_release is null then raise exception 'confirmed release is unavailable' using errcode = '42501'; end if;
  for v_id in select unnest(p_media_ids) loop
    select candidate into v_media
    from (
      select post.value -> 'coverMedia' as candidate from jsonb_array_elements(v_release -> 'posts') post
      union all
      select media.value as candidate from jsonb_array_elements(v_release -> 'posts') post
        cross join lateral jsonb_array_elements(coalesce(post.value -> 'media', '[]'::jsonb)) media
    ) candidates
    where candidate ->> 'id' = v_id
    limit 1;
    if v_media is null or jsonb_typeof(v_media -> 'variants') <> 'array' then
      raise exception 'media is not referenced by a confirmed release' using errcode = '42501';
    end if;
    if not exists (select 1 from public.blog_media m where m.id = v_id and m.owner_id = p_user_id and m.state = 'complete' and m.variants = v_media -> 'variants' and blog_private.media_group_valid(v_id, p_user_id)) then
      raise exception 'confirmed release media no longer matches its immutable group' using errcode = '42501';
    end if;
    v_result := v_result || jsonb_build_array(jsonb_build_object('id', v_id, 'owner_id', p_user_id, 'state', 'complete', 'variants', v_media -> 'variants'));
    v_count := v_count + 1;
  end loop;
  if v_count <> cardinality(p_media_ids) then raise exception 'media promotion manifest is incomplete' using errcode = '42501'; end if;
  return v_result;
end;
$$;

revoke all on function public.blog_media_record_variant(uuid,uuid,bigint,text,jsonb) from public, anon, authenticated, service_role;
revoke all on function public.blog_media_complete(uuid,uuid,bigint,text) from public, anon, authenticated, service_role;
revoke all on function public.blog_media_promotion_manifest(uuid,uuid,bigint,text[]) from public, anon, authenticated, service_role;
revoke all on function public.blog_media_revalidate_session(uuid,uuid,bigint) from public, anon, authenticated, service_role;
revoke all on function blog_private.blog_media_revalidate_session(uuid,uuid,bigint) from public, anon, authenticated, service_role;
grant execute on function public.blog_media_record_variant(uuid,uuid,bigint,text,jsonb) to service_role;
grant execute on function public.blog_media_complete(uuid,uuid,bigint,text) to service_role;
grant execute on function public.blog_media_promotion_manifest(uuid,uuid,bigint,text[]) to service_role;
grant execute on function public.blog_media_revalidate_session(uuid,uuid,bigint) to service_role;

commit;
