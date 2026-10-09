// oauth-lib.ts — small helpers shared by routes/oauth.ts and routes/mcp.ts.
// Tokens and codes are opaque random strings; only their sha256 hex is stored
// (tables from 0013_mcp_oauth.sql). Raw values are never logged or audited.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { pool } from './db/pool.js';

export const ACCESS_TTL_S = 3600;
export const REFRESH_TTL_S = 30 * 24 * 3600;
export const CODE_TTL_S = 60;
export const MAX_CLIENTS = 20;
export const SCOPE = 'mcp';

export const ALLOWED_REDIRECT_URIS = [
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
];

// Public origin of this API as seen by clients (the tunnel hostname).
export function issuer(): string {
  return (process.env.OAUTH_ISSUER || 'https://spaghettios.bentleyos.me').replace(/\/+$/, '');
}

export function sha256hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

// RFC 7636 S256: base64url(sha256(verifier)).
export function pkceS256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

// Fixed-window in-memory limiter. Single api process, so process memory is enough.
const windows = new Map<string, { n: number; reset: number }>();
export function rateLimited(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  if (windows.size > 5000) for (const [k, v] of windows) if (v.reset < now) windows.delete(k);
  const w = windows.get(key);
  if (!w || w.reset < now) {
    windows.set(key, { n: 1, reset: now + windowMs });
    return false;
  }
  w.n += 1;
  return w.n > max;
}

export function clientIp(headers: { get(n: string): string | null | undefined }): string {
  return headers.get('cf-connecting-ip') || (headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'local';
}

// Returns the client_id for a live (unexpired, unrevoked) access token, else null.
export async function verifyAccessToken(raw: string): Promise<string | null> {
  const { rows } = await pool.query<{ client_id: string }>(
    `select client_id from oauth_tokens
     where access_token_hash = $1 and revoked_at is null and access_expires_at > now()`,
    [sha256hex(raw)],
  );
  return rows[0]?.client_id ?? null;
}
