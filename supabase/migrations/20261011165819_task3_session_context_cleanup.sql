create or replace function blog_private.touch_editorial_post()
returns trigger
language plpgsql
set search_path = pg_catalog, blog_private
as $$
declare
  v_session_id text := nullif(current_setting('blog.editorial_session_id', true), '');
  v_generation text := nullif(current_setting('blog.editorial_session_generation', true), '');
  v_user_id text := nullif(current_setting('blog.editorial_user_id', true), '');
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
