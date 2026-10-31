// Clean-package, in-memory MCP/daemon acceptance. No real Codex model call.
// Requires a verified public-preview bundle and the isolated theo-lab setup.
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {startTaskDaemon} from '../src/task-daemon.mjs';
import {TaskBridge} from '../src/task-bridge.mjs';
import {makeServer} from '../src/mcp.mjs';
import {findCodexExecutable} from '../src/codex-binary.mjs';
import {loadReadOnlyRegistry} from '../src/readonly-registry.mjs';
import {verifyPortableBundle} from './verify-portable-bundle.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const verified=verifyPortableBundle(root);
if(verified.verdict!=='PASS')throw Error('PORTABLE_INTEGRITY_FAILED');
const ids=Object.keys(loadReadOnlyRegistry(root).projects);
if(ids.length!==1||ids[0]!=='theo-lab')throw Error('PORTABLE_LAB_NOT_ISOLATED');
let daemon,server,client;
try{
 daemon=await startTaskDaemon({root});
 const bridge=new TaskBridge({root,autostart:false});
 server=makeServer({
  codexPath:findCodexExecutable(),
  workspace:root,remoteCoordinator:bridge,
  authState:'LOCAL_TEST_ONLY',transportKind:'isolated-in-memory'
 });
 client=new Client({name:'theo-portable-smoke',version:'1'});
 const [mcpIn,mcpOut]=InMemoryTransport.createLinkedPair();
 await Promise.all([server.connect(mcpIn),client.connect(mcpOut)]);
 const tools=(await client.listTools()).tools;
 const names=tools.map(x=>x.name).sort();
 const expected=['standalone_capabilities','standalone_codex_probe','standalone_list_projects',
  'standalone_task_events','standalone_task_result','standalone_task_start',
  'standalone_task_status','standalone_task_stop'].sort();
 if(JSON.stringify(names)!==JSON.stringify(expected))
  throw Error('PORTABLE_MCP_TOOL_SET_INVALID');
 const cap=await client.callTool({name:'standalone_capabilities',arguments:{}});
 const v=JSON.parse(cap.content[0].text);
 if(cap.isError||v.writeEnabled!==false||v.candidateWriteEnabled!==false||
    !v.realCodexTaskEnabled||!v.taskStartEnabled)
  throw Error('PORTABLE_CAPABILITY_INVALID');
 const projects=await client.callTool({name:'standalone_list_projects',arguments:{}});
 if(projects.isError||JSON.stringify(JSON.parse(projects.content[0].text))!=='[{"id":"theo-lab"}]')
  throw Error('PORTABLE_PROJECT_SCOPE_INVALID');
 console.log(JSON.stringify({
  verdict:'PASS',toolCount:names.length,projects:['theo-lab'],
  realCodexTurnStarted:false,ownerApprovalRequested:false,writeEnabled:false,
  externalTunnelStarted:false,
  packageFilesChecked:verified.fileCount
 }));
}finally{
 try{await client?.close();}catch{}
 try{await server?.close();}catch{}
 try{await daemon?.stop();}catch{}
}
