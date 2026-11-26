// Deliberately minimal dependencies; proves migration/FK behavior, not auth.
export const setupKnowledgeStorageFixture = `
create schema auth; create schema private;
create role anon; create role authenticated; create role service_role;
create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql as $$select null::uuid$$;
create function private.lock_case_graph(uuid[],uuid[]) returns void language sql as $$select$$;
create function private.mfa_satisfied() returns boolean language sql as $$select true$$;
create function private.mi1_w2_selected_organization() returns uuid language sql as $$select null::uuid$$;
create function private.has_organization_role(uuid,text[]) returns boolean language sql as $$select true$$;
create function private.mi1_w2_download_knowledge_file(uuid,boolean) returns void language sql as $$select$$;
create table public.organization_knowledge_files(
 id uuid primary key, organization_id uuid, storage_handle uuid,
 storage_kind text not null, storage_path text not null,
 created_by uuid references auth.users(id) on delete set null,
 review_status text, file_name text, mime_type text);
insert into auth.users values('00000000-0000-4000-8000-000000000001');
insert into public.organization_knowledge_files(id,storage_kind,storage_path,created_by)
 values('00000000-0000-4000-8000-000000000002','external_url','https://example.test/legacy','00000000-0000-4000-8000-000000000001');
`;

export const assertKnowledgeStorageLifecycle = `
do $$begin
 begin
  insert into public.organization_knowledge_files(id,storage_kind,storage_path)
   values('00000000-0000-4000-8000-000000000003','external_url','https://example.test/new');
  raise exception 'new external file accepted';
 exception when check_violation then null; end;
 begin
  update public.organization_knowledge_files set storage_path='https://example.test/changed';
  raise exception 'legacy external location changed';
 exception when check_violation then null; end;
 begin
  update public.organization_knowledge_files set storage_handle='00000000-0000-4000-8000-000000000005';
  raise exception 'legacy external handle changed';
 exception when check_violation then null; end;
 delete from auth.users;
 if exists(select 1 from public.organization_knowledge_files where created_by is not null) then
  raise exception 'legacy uploader was not detached';
 end if;
 if (select count(*) from public.organization_knowledge_files) <> 1 then
  raise exception 'legacy file was deleted';
 end if;
 insert into public.organization_knowledge_files(id,storage_kind,storage_path)
  values('00000000-0000-4000-8000-000000000004','organization_storage','org/object');
 begin
  update public.organization_knowledge_files set storage_kind='external_url'
   where id='00000000-0000-4000-8000-000000000004';
  raise exception 'stored file converted to external';
 exception when check_violation then null; end;
 raise notice 'PASS: actual migration refuses new/changed external storage and preserves account deletion';
end$$;
`;

export function knowledgeStoragePredecessor(migration) {
  const current = migration.match(/CREATE OR REPLACE FUNCTION public\.get_knowledge_file_storage_target[\s\S]*?\$function\$;/)?.[0];
  if (!current) throw new Error("Storage target definition missing");
  return current.replace(/ {2}if file\.storage_kind is distinct from 'organization_storage' then\n {4}raise exception 'file is not stored here' using errcode = '22023', detail = 'knowledge_file_external_unsupported';\n {2}end if;\n/, "");
}
