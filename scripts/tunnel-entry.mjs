// Dedicated diagnostic-only MCP entrypoint for the new Standalone Secure MCP Tunnel.
// No Codex model turn, project mutation, or external listener is available here.
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {makeServer} from '../src/mcp.mjs';
import {findCodexExecutable} from '../src/codex-binary.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const server=makeServer({
  codexPath:findCodexExecutable(),
  workspace:root,
  authState:'openai-tunnel-transport',
  transportKind:'standalone-tunnel-stdio'
});
await server.connect(new StdioServerTransport());
