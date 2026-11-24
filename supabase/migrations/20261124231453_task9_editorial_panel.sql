create function public.blog_publication_current(
  p_user_id uuid,
  p_session_id uuid,
  p_auth_session_id uuid,
  p_generation bigint
) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, blog_private, public, auth
as $$
declare v_request_id uuid;
begin
  if auth.role() is distinct from 'service_role'
    or not blog_private.media_admin_session_live(p_user_id, p_session_id, p_generation)
    or not exists (
      select 1 from blog_private.admin_sessions
      where session_id = p_session_id and generation = p_generation
        and user_id = p_user_id and auth_session_id = p_auth_session_id
    ) then
    raise exception 'editor authorization is required' using errcode = '42501';
  end if;

  select r.request_id into v_request_id
  from blog_private.publication_requests r
  join blog_private.build_slot b on b.singleton
  where r.owner_id = p_user_id
    and (r.request_id = b.active_request_id or r.state = 'live')
  order by (r.request_id is not distinct from b.active_request_id) desc, r.created_at desc, r.request_id
  limit 1;

  if v_request_id is null then return null; end if;
  return public.blog_publication_status(p_user_id, p_session_id, p_auth_session_id, p_generation, v_request_id);
end;
$$;
revoke execute on function public.blog_publication_current(uuid,uuid,uuid,bigint) from public, anon, authenticated;
grant execute on function public.blog_publication_current(uuid,uuid,uuid,bigint) to service_role;
