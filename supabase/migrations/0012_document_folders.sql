-- 0012_document_folders.sql
-- Adds a folder label to documents: a fact about the document, not a
-- separate entity. A folder groups documents by name only, created on the
-- fly at upload time, and never carries its own metadata -- so it lives as a
-- column here, the same as `mime` or `title`, not a registered object_type
-- (store each fact once; don't stand up a table for a value).
--
-- Every existing document gets 'general' via the column default -- no doc is
-- left unfoldered, and the corpus stays fully queryable with no folder filter
-- applied (an absent filter param at retrieval = search everything, same as
-- today).
--
-- Normalized lowercase/trimmed at write time in the api upload route; the
-- CHECK constraint is the backstop against a future write path skipping
-- that normalization.

alter table documents add column if not exists folder text not null default 'general';

alter table documents drop constraint if exists documents_folder_normalized;
alter table documents add constraint documents_folder_normalized
  check (folder = lower(trim(folder)) and folder <> '');

create index if not exists idx_documents_folder
  on documents (folder);
