// Theo Synapse's read-only task-capable MCP endpoint.
// JSON-RPC/stdio is ephemeral; persistent state lives behind private local Unix IPC.
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {TaskBridge} from '../src/task-bridge.mjs';
import {isNativeCoreRoot} from '../src/native-core.mjs';
import {makeServer} from '../src/mcp.mjs';
import {findCodexExecutable} from '../src/codex-binary.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
// Probe only the already-running local daemon. This bounded, read-only check
// never starts a daemon and an unavailable/invalid response fails closed.
const schemaProbe=process.env.THEO_SCHEMA_PROBE==='1';
const probe=new TaskBridge({root,autostart:false,timeout:600});
let directCoordinator=null;
try{
 const capability=await probe.directCapabilities();
 // The daemon can report this only when its trusted native host injected a
 // coordinator. No environment variable or MCP argument can enable it.
 if(capability?.enabled===true&&capability.ownerApproval==='host_callback_required'){
  directCoordinator={start:request=>probe.directStart(request),wait:request=>probe.directWait(request)};
 }
}catch{}
// Legacy/source read-only operations retain historical autostart.
// In the installed native Core, only the Owner-managed LaunchAgent may start
// the shared socket. Tunnel requests cannot create an unmanaged daemon while
// the Owner switches between READONLY(8) and DIRECT(10).
// Schema discovery remains inert, including the direct capability probe.
const client=new TaskBridge({root,autostart:!schemaProbe&&!isNativeCoreRoot(root),timeout:10000});
const server=makeServer({
 codexPath:findCodexExecutable(),
 workspace:root,
 remoteCoordinator:client,
 directCoordinator,
 authState:'openai-tunnel-transport',
 transportKind:'standalone-tunnel-stdio'
});
await server.connect(new StdioServerTransport());
