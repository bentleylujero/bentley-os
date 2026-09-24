-- 0013_mcp_oauth.sql — OAuth 2.1 storage for the remote MCP connector (Ticket 5)
-- Three object types, ontology-first: each is a fact about the OAuth protocol
-- itself, not a duplicate of anything `documents`/`actions` already own.
-- Tokens are opaque (random), never JWTs — so storage is required regardless
-- of format, and revocation is a plain row delete/flag, not a signature
-- problem. Rows here store HASHES only; raw tokens/codes/secrets never touch
-- the database (see apps/api/src/routes/oauth.ts).

create table if not exists oauth_clients (
  client_id                  text primary key,
  client_secret_hash         text,                 -- null = public client (PKCE-only, no secret)
  client_name                text,
  redirect_uris               jsonb not null,       -- array of allowed exact-match redirect URIs
  token_endpoint_auth_method text not null default 'none',
  grant_types                jsonb not null default '["authorization_code","refresh_token"]',
  created_at                 timestamptz not null default now()
);

create table if not exists oauth_authorization_codes (
  code_hash             text primary key,
  client_id             text not null references oauth_clients(client_id) on delete cascade,
  redirect_uri          text not null,
  code_challenge        text not null,
  code_challenge_method text not null default 'S256',
  scope                 text,
  created_at            timestamptz not null default now(),
  expires_at            timestamptz not null,
  used_at               timestamptz            -- non-null = already redeemed; codes are single-use
);

create table if not exists oauth_tokens (
  access_token_hash   text primary key,
  refresh_token_hash  text unique,
  client_id           text not null references oauth_clients(client_id) on delete cascade,
  scope               text,
  created_at          timestamptz not null default now(),
  access_expires_at   timestamptz not null,
  refresh_expires_at  timestamptz,
  revoked_at          timestamptz
);

create index if not exists idx_oauth_codes_expires on oauth_authorization_codes (expires_at);
create index if not exists idx_oauth_tokens_refresh on oauth_tokens (refresh_token_hash);
create index if not exists idx_oauth_tokens_client on oauth_tokens (client_id);
