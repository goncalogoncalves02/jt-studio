begin;

do $task3_editorial$
declare
  v_post_oid oid := to_regclass('public.blog_posts');
  v_media_oid oid := to_regclass('public.blog_media');
  v_large_doc jsonb;
begin
  if v_post_oid is null or v_media_oid is null then
    raise exception 'Task 3 editorial tables are missing';
  end if;
  if not (select relrowsecurity from pg_class where oid = v_post_oid) then
    raise exception 'blog_posts must have RLS enabled';
  end if;
  if not (select relrowsecurity from pg_class where oid = v_media_oid) then
    raise exception 'blog_media must have RLS enabled';
  end if;
  if has_table_privilege('anon', v_post_oid, 'SELECT') then
    raise exception 'anon must not read blog_posts';
  end if;
  if not has_table_privilege('authenticated', v_post_oid, 'SELECT') then
    raise exception 'authenticated must have RLS-filtered blog_posts read access';
  end if;
  if has_table_privilege('authenticated', v_post_oid, 'INSERT,UPDATE,DELETE') then
    raise exception 'authenticated must not bypass editorial RPCs with direct writes';
  end if;
  if has_table_privilege('service_role', v_post_oid, 'SELECT,INSERT,UPDATE,DELETE') then
    raise exception 'service_role must use the scoped owner RPCs rather than direct editorial table access';
  end if;
  if has_schema_privilege('anon', 'blog_private', 'USAGE') then
    raise exception 'private schema must not be reachable by anon';
  end if;
  if has_schema_privilege('authenticated', 'blog_private', 'USAGE') is false then
    raise exception 'authenticated needs private helper usage for owner RLS evaluation';
  end if;
  if has_function_privilege('anon', 'public.blog_save_post(jsonb,bigint,uuid,bigint)', 'EXECUTE') then
    raise exception 'anon must not execute editorial RPCs';
  end if;
  if not has_function_privilege('authenticated', 'public.blog_save_post(jsonb,bigint,uuid,bigint)', 'EXECUTE') then
    raise exception 'authenticated owner RPC must be explicitly executable';
  end if;
  if has_function_privilege('service_role', 'public.blog_save_post(jsonb,bigint,uuid,bigint)', 'EXECUTE') then
    raise exception 'service_role must not bypass auth.uid() through the owner RPC';
  end if;
  if has_function_privilege('anon', 'public.blog_freeze_release(uuid,bigint,uuid,text)', 'EXECUTE') then
    raise exception 'anon must not freeze releases';
  end if;
  if not exists (
    select 1 from blog_private.settings where singleton and authorized_owner_id is null
  ) then
    raise exception 'production migration must leave owner authorization unset';
  end if;
  if not blog_private.document_v1_valid('{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"ok"}]}]}'::jsonb) then
    raise exception 'the canonical DocumentV1 positive case must pass at the database boundary';
  end if;
  if blog_private.document_v1_valid('{"type":"paragraph","content":[{"type":"text","text":"root paragraph"}]}'::jsonb)
    or blog_private.document_v1_valid('{"type":"text","text":"root text"}'::jsonb)
    or blog_private.document_v1_valid('{"type":"bulletList","content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"root list"}]}]}]}'::jsonb)
    or blog_private.document_v1_valid('{"type":"image","attrs":{"mediaId":"root-image","alt":"root image"}}'::jsonb) then
    raise exception 'DocumentV1 roots other than doc must fail closed';
  end if;
  if not blog_private.document_v1_valid('{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"A","marks":[{"type":"bold"}]},{"type":"text","text":" "},{"type":"text","text":"B","marks":[{"type":"italic"}]}]}]}'::jsonb) then
    raise exception 'DocumentV1 must preserve a whitespace-only text node between formatted spans';
  end if;
  if not blog_private.document_v1_valid('{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":" \n\t\u00a0"}]}]}'::jsonb) then
    raise exception 'whitespace-only text spans must remain valid DocumentV1';
  end if;
  if blog_private.document_has_text('{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":" \n\t\u00a0"}]}]}'::jsonb) then
    raise exception 'ASCII and NBSP whitespace-only content must not make an article ready';
  end if;
  if blog_private.document_v1_valid('{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"x","attrs":{"onerror":"alert(1)"}}]}]}'::jsonb) then
    raise exception 'unknown executable document attributes must fail closed';
  end if;
  if blog_private.document_v1_valid('{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"x","marks":[{"type":"bold"},{"type":"bold"}]}]}]}'::jsonb) then
    raise exception 'duplicate document marks must fail closed';
  end if;
  if blog_private.document_v1_valid('{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"x","marks":[{"type":"link","attrs":{"href":"javascript:alert(1)"}}]}]}]}'::jsonb) then
    raise exception 'executable links must fail closed';
  end if;
  if not blog_private.document_v1_valid('{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"email","marks":[{"type":"link","attrs":{"href":"mailto:hello@example.com"}}]}]}]}'::jsonb)
    or not blog_private.document_v1_valid('{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"phone","marks":[{"type":"link","attrs":{"href":"tel:+15550100"}}]}]}]}'::jsonb) then
    raise exception 'approved mailto and tel links must pass DocumentV1 validation';
  end if;
  if blog_private.document_v1_valid('{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text"}]}]}'::jsonb) then
    raise exception 'text nodes without a string value must fail closed';
  end if;
  select jsonb_build_object('type','doc','content',jsonb_agg(jsonb_build_object('type','paragraph','content',jsonb_build_array(jsonb_build_object('type','text','text','x')))))
    into v_large_doc from generate_series(1,2500);
  if blog_private.document_v1_valid(v_large_doc) then
    raise exception 'DocumentV1 must reject more than 5000 nodes';
  end if;
  if blog_private.document_v1_valid(jsonb_build_object('type','doc','content',jsonb_build_array(jsonb_build_object('type','paragraph','content',jsonb_build_array(jsonb_build_object('type','text','text',repeat('x',270000))))))) then
    raise exception 'DocumentV1 must reject payloads above 256 KiB';
  end if;
  if blog_private.document_v1_valid('{"type":"doc","content":[{"type":"heading","attrs":{"level":"2"},"content":[{"type":"text","text":"x"}]}]}'::jsonb) then
    raise exception 'DocumentV1 heading attributes must use the canonical number type';
  end if;
  if blog_private.document_v1_valid('{"type":"doc","content":[{"type":"heading","attrs":[],"content":[{"type":"text","text":"x"}]}]}'::jsonb) then
    raise exception 'DocumentV1 heading attributes must be a strict object';
  end if;
  if blog_private.document_v1_valid('{"type":"doc","content":[{"type":"image","attrs":[]}]}'::jsonb) then
    raise exception 'DocumentV1 image attributes must be a strict object';
  end if;
  if blog_private.document_v1_valid('{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"x","marks":[{"type":"link","attrs":[]}]}]}]}'::jsonb) then
    raise exception 'DocumentV1 link attributes must be a strict object';
  end if;
  if blog_private.document_v1_valid('{"type":"doc","content":[{"type":"heading","attrs":{"level":"not-a-number"},"content":[{"type":"text","text":"x"}]}]}'::jsonb) then
    raise exception 'DocumentV1 must reject non-numeric heading levels without casting untrusted strings';
  end if;
  insert into public.blog_media (id, owner_id, state, pipeline_version, variants)
  values ('task3-malformed-variant-fixture', '00000000-0000-0000-0000-000000000103', 'complete', 1, '[[]]'::jsonb);
  if blog_private.media_group_valid('task3-malformed-variant-fixture', '00000000-0000-0000-0000-000000000103') then
    raise exception 'variant arrays must contain only strict object values';
  end if;
  insert into public.blog_media (id, owner_id, state, pipeline_version, variants)
  values (
    'task3-oversized-variant-fixture',
    '00000000-0000-0000-0000-000000000103',
    'complete',
    1,
    '[{"width":1601,"height":1000,"mime":"image/webp","byteLength":1024,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","objectKey":"public/task3-oversized.webp"}]'::jsonb
  );
  if blog_private.media_group_valid('task3-oversized-variant-fixture', '00000000-0000-0000-0000-000000000103') then
    raise exception 'complete media metadata must stay within the approved 1600-pixel output bound';
  end if;
end;
$task3_editorial$;

rollback;
