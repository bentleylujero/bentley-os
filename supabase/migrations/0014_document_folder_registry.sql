-- 0014_document_folder_registry.sql
-- A folder now carries its own fact -- whether the MCP relay may expose it to
-- connected Claudes -- so it earns a row (0012 said a folder would stay a bare
-- column "while it never carries its own metadata"; that stopped being true).
-- documents.folder REMAINS the sole record of which folder a document is in;
-- this table holds only facts about the folder itself.
--
-- Fail-closed: a folder is NOT exposed to MCP unless mcp_exposed = true. The
-- only writers of that flag are the dashboard routes in apps/api -- no MCP tool
-- can touch it, so a connected Claude can never widen its own access.
-- (Replaces the MCP_ALLOWED_FOLDERS env var, which becomes ignored.)
--
-- Auto-registration: a BEFORE trigger on documents registers any folder it has
-- not seen (exposed = false), so every writer -- including a stale api build
-- still running during a deploy -- keeps working, and the FK below can never
-- reject a legitimate insert.
--
-- Dedupe: a partial unique index on (folder, source_id) lets the upload route
-- store a content hash in source_id ('sha256:<hex>') and skip identical
-- re-uploads, which makes bulk directory ingest safely re-runnable.

create table if not exists document_folders (
  name        text primary key
              check (name = lower(trim(name)) and name <> ''),
  mcp_exposed boolean not null default false,
  created_at  timestamptz not null default now()
);

-- Backfill from what exists today. 'general' is the one folder the relay has
-- been exposing (MCP_ALLOWED_FOLDERS=general), so it keeps that.
insert into document_folders (name, mcp_exposed)
  select distinct folder, (folder = 'general') from documents
  on conflict (name) do nothing;
insert into document_folders (name, mcp_exposed)
  values ('general', true)
  on conflict (name) do nothing;

create or replace function documents_register_folder() returns trigger
language plpgsql as $$
begin
  insert into document_folders (name) values (new.folder)
    on conflict (name) do nothing;
  return new;
end;
$$;

drop trigger if exists trg_documents_register_folder on documents;
create trigger trg_documents_register_folder
  before insert or update of folder on documents
  for each row execute function documents_register_folder();

alter table documents drop constraint if exists documents_folder_fkey;
alter table documents add constraint documents_folder_fkey
  foreign key (folder) references document_folders (name) on update cascade;

create unique index if not exists uq_documents_folder_source_id
  on documents (folder, source_id) where source_id is not null;
