// mcp.ts — remote Streamable HTTP MCP endpoint (Path B). Stateless: a fresh
// McpServer + transport per request, no session id. The same registerTools()
// as the stdio relay, so isExposed() gates every folder identically.
import { Hono } from 'hono';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { registerTools } from '../mcp-tools.js';
import { audit } from '../db/audit.js';
import { issuer, verifyAccessToken } from '../oauth-lib.js';

export const mcpRoute = new Hono();

mcpRoute.all('/mcp', async (c) => {
  const m = /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') || '');
  const clientId = m ? await verifyAccessToken(m[1]) : null;
  if (!clientId) {
    await audit({ action: 'mcp.auth_rejected', outcome: m ? 'invalid_expired_or_revoked' : 'missing_bearer', payload: { transport: 'http', method: c.req.method } });
    return c.body(null, 401, {
      'WWW-Authenticate': `Bearer resource_metadata="${issuer()}/.well-known/oauth-protected-resource"`,
    });
  }
  const server = new McpServer({ name: 'bentley-os-folders', version: '1.0.0' });
  registerTools(server, { transport: 'http', clientId });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  return transport.handleRequest(c.req.raw);
});
