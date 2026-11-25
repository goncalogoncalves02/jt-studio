create or replace function blog_private.document_text_has_content(p_text text)
returns boolean
language sql
immutable
set search_path = pg_catalog
as $$
  select length(btrim(p_text,
    chr(9) || chr(10) || chr(11) || chr(12) || chr(13) || chr(32) || chr(160) || chr(5760) ||
    chr(8192) || chr(8193) || chr(8194) || chr(8195) || chr(8196) || chr(8197) || chr(8198) ||
    chr(8199) || chr(8200) || chr(8201) || chr(8202) || chr(8232) || chr(8233) || chr(8239) ||
    chr(8287) || chr(12288) || chr(65279))) > 0;
$$;

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
      if jsonb_typeof(p_node -> 'text') is distinct from 'string' or length(p_node ->> 'text') = 0 then return false; end if;
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
  select exists(
    select 1 from nodes
    where node ->> 'type' = 'text'
      and blog_private.document_text_has_content(node ->> 'text')
  );
$$;
