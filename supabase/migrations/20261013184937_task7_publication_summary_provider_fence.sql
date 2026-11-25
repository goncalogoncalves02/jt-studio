create or replace function public.blog_publication_summary(p_session_id uuid,p_generation bigint)
returns jsonb language plpgsql security definer
set search_path=pg_catalog,blog_private,public,auth
as $$
declare v_owner_id uuid;
begin
  v_owner_id:=blog_private.assert_admin_session(p_session_id,p_generation);
  perform blog_private.revalidate_admin_session(p_session_id,p_generation,v_owner_id);
  if not blog_private.media_admin_session_live(v_owner_id,p_session_id,p_generation) then
    raise exception 'editor authorization is required' using errcode='42501';
  end if;
  return blog_private.current_publication_summary(v_owner_id);
end;
$$;
