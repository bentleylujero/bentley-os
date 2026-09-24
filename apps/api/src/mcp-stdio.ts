// mcp-stdio.ts — stdio transport wiring for the read-only MCP relay. All tool
// logic lives in mcp-tools.ts (transport-agnostic); this file only builds the
// McpServer, registers the tools, and connects it to stdio.
//
// This is a SEPARATE entrypoint from index.ts, launched directly by Claude
// Desktop as `docker exec -i <container> env MCP_ALLOWED_FOLDERS=... node
// dist/mcp-stdio.js`. It must never import routes/index.ts or
// ingestion/scheduler.ts — those pull in the cron drain and the Telegram
// webhook guard (which throws at import time if its env vars are unset), and
// neither belongs on a stdio-only process a human launches ad hoc.
//
// stdio protocol discipline: nothing may reach stdout except the SDK's own
// newline-delimited JSON-RPC traffic. All diagnostics go to stderr.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerTools } from './mcp-tools.js';

const server = new McpServer({ name: 'bentley-os-folders', version: '1.0.0' });
registerTools(server);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('[mcp-stdio] fatal error', err);
  process.exit(1);
});
