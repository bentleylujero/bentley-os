// oauth.ts — OAuth 2.1 authorization server for the remote MCP connector (Path B).
// Public clients only, PKCE S256 only, dynamic client registration restricted to
// the claude.ai / claude.com callback URIs. Storage: 0013_mcp_oauth.sql (hashes only).
// /authorize needs the Cloudflare Access identity header; the other endpoints are
// called machine-to-machine by claude.ai and must be reachable without Access.
import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { pool } from '../db/pool.js';
import { audit } from '../db/audit.js';
import {
  ACCESS_TTL_S, REFRESH_TTL_S, CODE_TTL_S, MAX_CLIENTS, SCOPE, ALLOWED_REDIRECT_URIS,
  issuer, sha256hex, randomToken, pkceS256, safeEqual, esc, rateLimited, clientIp,
} from '../oauth-lib.js';

export const oauthRoute = new Hono();

const VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;
const CHALLENGE_RE = /^[A-Za-z0-9\-_]{43}$/;
const ACCESS_HEADER = 'cf-access-authenticated-user-email';

oauthRoute.get('/.well-known/oauth-protected-resource', (c) => c.json(protectedResource()));
oauthRoute.get('/.well-known/oauth-protected-resource/mcp', (c) => c.json(protectedResource()));
function protectedResource() {
  const iss = issuer();
  return { resource: `${iss}/mcp`, authorization_servers: [iss], bearer_methods_supported: ['header'], scopes_supported: [SCOPE] };
}

oauthRoute.get('/.well-known/oauth-authorization-server', (c) => {
  const iss = issuer();
  return c.json({
    issuer: iss,
    authorization_endpoint: `${iss}/authorize`,
    token_endpoint: `${iss}/token`,
    registration_endpoint: `${iss}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [SCOPE],
  });
});

// ---------------------------------------------------------------- /register
oauthRoute.post('/register', async (c) => {
  if (rateLimited(`reg:${clientIp(c.req.raw.headers)}`, 10, 60_000)) {
    return c.json({ error: 'temporarily_unavailable', error_description: 'rate limited' }, 429);
  }
  const body = await c.req.json().catch(() => null);
  const uris = body?.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || !uris.every((u) => typeof u === 'string' && ALLOWED_REDIRECT_URIS.includes(u))) {
    await audit({ action: 'oauth.register', outcome: 'rejected_redirect_uri', payload: { requested: Array.isArray(uris) ? uris.slice(0, 5) : null } });
    return c.json({ error: 'invalid_redirect_uri', error_description: 'redirect_uris must be exactly the claude.ai/claude.com MCP callback URIs' }, 400);
  }
  const name = typeof body?.client_name === 'string' ? body.client_name.slice(0, 100) : null;
  const clientId = randomToken(16);
  const { rowCount } = await pool.query(
    `insert into oauth_clients (client_id, client_secret_hash, client_name, redirect_uris, token_endpoint_auth_method)
     select $1, null, $2, $3::jsonb, 'none'
     where (select count(*) from oauth_clients) < $4`,
    [clientId, name, JSON.stringify([...new Set(uris)]), MAX_CLIENTS],
  );
  if (!rowCount) {
    await audit({ action: 'oauth.register', outcome: 'rejected_client_cap', payload: { cap: MAX_CLIENTS } });
    return c.json({ error: 'temporarily_unavailable', error_description: 'client limit reached' }, 429);
  }
  await audit({ action: 'oauth.register', target: clientId, outcome: 'success', payload: { client_name: name } });
  return c.json(
    {
      client_id: clientId,
      client_name: name,
      redirect_uris: [...new Set(uris)],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    },
    201,
  );
});

// --------------------------------------------------------------- /authorize
interface AuthParams {
  client_id: string; redirect_uri: string; response_type: string;
  code_challenge: string; code_challenge_method: string; state: string; scope: string;
}
function pickParams(src: Record<string, unknown>): AuthParams {
  const g = (k: string) => (typeof src[k] === 'string' ? (src[k] as string) : '');
  return {
    client_id: g('client_id'), redirect_uri: g('redirect_uri'), response_type: g('response_type'),
    code_challenge: g('code_challenge'), code_challenge_method: g('code_challenge_method'),
    state: g('state'), scope: g('scope'),
  };
}

// Client id and redirect URI must be valid BEFORE anything may redirect to it.
async function loadClient(p: AuthParams): Promise<{ client_name: string | null } | null> {
  if (!p.client_id) return null;
  const { rows } = await pool.query(`select client_name, redirect_uris from oauth_clients where client_id = $1`, [p.client_id]);
  const r = rows[0];
  if (!r || !Array.isArray(r.redirect_uris) || !r.redirect_uris.includes(p.redirect_uri)) return null;
  return { client_name: r.client_name };
}

function redirectTo(p: AuthParams, params: Record<string, string>) {
  const u = new URL(p.redirect_uri);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  if (p.state) u.searchParams.set('state', p.state);
  return u.toString();
}

function paramError(p: AuthParams): string | null {
  if (p.response_type !== 'code') return 'unsupported_response_type';
  if (p.code_challenge_method !== 'S256' || !CHALLENGE_RE.test(p.code_challenge)) return 'invalid_request';
  return null;
}

function deny403(c: any, p: AuthParams, why: string) {
  return audit({ action: 'oauth.authorize_denied', target: p.client_id || null, outcome: why, payload: {} }).then(() =>
    c.text('Forbidden: Cloudflare Access identity required.', 403),
  );
}

oauthRoute.get('/authorize', async (c) => {
  const p = pickParams(c.req.query());
  const identity = c.req.header(ACCESS_HEADER);
  if (!identity) return deny403(c, p, 'no_access_identity');
  const client = await loadClient(p);
  if (!client) {
    await audit({ action: 'oauth.authorize_denied', target: p.client_id || null, outcome: 'invalid_client_or_redirect', payload: {} });
    return c.text('Invalid client_id or redirect_uri.', 400);
  }
  const bad = paramError(p);
  if (bad) {
    await audit({ action: 'oauth.authorize_denied', target: p.client_id, outcome: bad, payload: {} });
    return c.redirect(redirectTo(p, { error: bad }), 302);
  }
  const csrf = randomToken(16);
  setCookie(c, 'oauth_csrf', csrf, { httpOnly: true, sameSite: 'Strict', secure: issuer().startsWith('https:'), path: '/authorize', maxAge: 600 });
  const hidden = Object.entries({ ...p, csrf }).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('');
  c.header('Cache-Control', 'no-store');
  c.header('X-Frame-Options', 'DENY');
  return c.html(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorize</title>` +
      `<body style="font-family:system-ui;max-width:28rem;margin:3rem auto;padding:0 1rem">` +
      `<h1>Authorize connector</h1><p><b>${esc(client.client_name || 'An MCP client')}</b> wants to read and add documents in the Claude-visible folders of Bentley OS.</p>` +
      `<p>Signed in as ${esc(identity)}</p>` +
      `<form method="post" action="/authorize">${hidden}` +
      `<button name="decision" value="approve">Approve</button> <button name="decision" value="deny">Deny</button></form></body>`,
  );
});

oauthRoute.post('/authorize', async (c) => {
  const form = await c.req.parseBody();
  const p = pickParams(form);
  const identity = c.req.header(ACCESS_HEADER);
  if (!identity) return deny403(c, p, 'no_access_identity');
  const cookie = getCookie(c, 'oauth_csrf') ?? '';
  const field = typeof form.csrf === 'string' ? form.csrf : '';
  if (!cookie || !field || !safeEqual(cookie, field)) {
    await audit({ action: 'oauth.authorize_denied', target: p.client_id || null, outcome: 'csrf', payload: {} });
    return c.text('Bad request (CSRF).', 400);
  }
  const client = await loadClient(p);
  if (!client) {
    await audit({ action: 'oauth.authorize_denied', target: p.client_id || null, outcome: 'invalid_client_or_redirect', payload: {} });
    return c.text('Invalid client_id or redirect_uri.', 400);
  }
  const bad = paramError(p);
  if (bad) {
    await audit({ action: 'oauth.authorize_denied', target: p.client_id, outcome: bad, payload: {} });
    return c.redirect(redirectTo(p, { error: bad }), 302);
  }
  if (form.decision !== 'approve') {
    await audit({ action: 'oauth.authorize_denied', target: p.client_id, outcome: 'user_denied', payload: { identity } });
    return c.redirect(redirectTo(p, { error: 'access_denied' }), 302);
  }
  const code = randomToken(32);
  await pool.query(
    `insert into oauth_authorization_codes (code_hash, client_id, redirect_uri, code_challenge, code_challenge_method, scope, expires_at)
     values ($1, $2, $3, $4, 'S256', $5, now() + make_interval(secs => $6))`,
    [sha256hex(code), p.client_id, p.redirect_uri, p.code_challenge, SCOPE, CODE_TTL_S],
  );
  await audit({ action: 'oauth.authorize_approved', target: p.client_id, outcome: 'success', payload: { identity } });
  return c.redirect(redirectTo(p, { code }), 302);
});

// ------------------------------------------------------------------- /token
function tokenError(c: any, status: 400 | 401 | 429, error: string, desc: string) {
  c.header('Cache-Control', 'no-store');
  return c.json({ error, error_description: desc }, status);
}

async function issuePair(clientId: string, scope: string) {
  const access = randomToken(32);
  const refresh = randomToken(32);
  await pool.query(
    `insert into oauth_tokens (access_token_hash, refresh_token_hash, client_id, scope, access_expires_at, refresh_expires_at)
     values ($1, $2, $3, $4, now() + make_interval(secs => $5), now() + make_interval(secs => $6))`,
    [sha256hex(access), sha256hex(refresh), clientId, scope, ACCESS_TTL_S, REFRESH_TTL_S],
  );
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_S, refresh_token: refresh, scope };
}

oauthRoute.post('/token', async (c) => {
  if (rateLimited(`tok:${clientIp(c.req.raw.headers)}`, 60, 60_000)) {
    return tokenError(c, 429, 'temporarily_unavailable', 'rate limited');
  }
  const ct = c.req.header('content-type') || '';
  const raw: Record<string, unknown> = ct.includes('json') ? ((await c.req.json().catch(() => ({}))) ?? {}) : await c.req.parseBody();
  const s = (k: string) => (typeof raw[k] === 'string' ? (raw[k] as string) : '');
  const clientId = s('client_id');
  const reject = async (status: 400 | 401, error: string, outcome: string, desc: string) => {
    await audit({ action: 'oauth.token_rejected', target: clientId || null, outcome, payload: { grant_type: s('grant_type') } });
    return tokenError(c, status, error, desc);
  };

  const { rows: cl } = clientId ? await pool.query(`select 1 from oauth_clients where client_id = $1`, [clientId]) : { rows: [] };
  if (!cl.length) return reject(401, 'invalid_client', 'unknown_client', 'unknown client');

  const grant = s('grant_type');
  if (grant === 'authorization_code') {
    const code = s('code');
    const verifier = s('code_verifier');
    if (!code || !VERIFIER_RE.test(verifier)) return reject(400, 'invalid_request', 'missing_code_or_verifier', 'code and a valid code_verifier are required');
    // Atomic single use: only one concurrent redeemer can flip used_at.
    const { rows } = await pool.query(
      `update oauth_authorization_codes set used_at = now()
       where code_hash = $1 and used_at is null and expires_at > now() returning *`,
      [sha256hex(code)],
    );
    const row = rows[0];
    if (!row) return reject(400, 'invalid_grant', 'code_invalid_used_or_expired', 'authorization code is invalid, used or expired');
    if (row.client_id !== clientId) return reject(400, 'invalid_grant', 'client_mismatch', 'code was issued to a different client');
    if (row.redirect_uri !== s('redirect_uri')) return reject(400, 'invalid_grant', 'redirect_uri_mismatch', 'redirect_uri does not match');
    if (!safeEqual(pkceS256(verifier), row.code_challenge)) return reject(400, 'invalid_grant', 'pkce_failed', 'code_verifier does not match');
    const out = await issuePair(clientId, row.scope || SCOPE);
    await audit({ action: 'oauth.token_issued', target: clientId, outcome: 'success', payload: { grant_type: grant } });
    c.header('Cache-Control', 'no-store');
    return c.json(out);
  }

  if (grant === 'refresh_token') {
    const rt = s('refresh_token');
    if (!rt) return reject(400, 'invalid_request', 'missing_refresh_token', 'refresh_token required');
    const h = sha256hex(rt);
    // Rotate atomically: revoke the presented row only if it is still live.
    const { rows } = await pool.query(
      `update oauth_tokens set revoked_at = now()
       where refresh_token_hash = $1 and client_id = $2 and revoked_at is null and refresh_expires_at > now()
       returning scope`,
      [h, clientId],
    );
    if (!rows[0]) {
      const { rows: prior } = await pool.query(`select revoked_at from oauth_tokens where refresh_token_hash = $1 and client_id = $2`, [h, clientId]);
      if (prior[0]?.revoked_at) {
        // A rotated-out refresh token came back: assume theft, kill every token for this client.
        const { rowCount } = await pool.query(`update oauth_tokens set revoked_at = now() where client_id = $1 and revoked_at is null`, [clientId]);
        await audit({ action: 'oauth.token_rejected', target: clientId, outcome: 'refresh_reuse_revoked_all', payload: { revoked: rowCount ?? 0 } });
        return tokenError(c, 400, 'invalid_grant', 'refresh token reuse detected; all tokens revoked');
      }
      return reject(400, 'invalid_grant', 'refresh_invalid_or_expired', 'refresh token is invalid or expired');
    }
    const out = await issuePair(clientId, rows[0].scope || SCOPE);
    await audit({ action: 'oauth.token_refreshed', target: clientId, outcome: 'success', payload: {} });
    c.header('Cache-Control', 'no-store');
    return c.json(out);
  }

  return reject(400, 'unsupported_grant_type', 'unsupported_grant_type', 'grant_type must be authorization_code or refresh_token');
});
