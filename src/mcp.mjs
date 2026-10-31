import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {z} from 'zod';
import {readFileSync} from 'node:fs';
import {CodexAppServer} from './codex-adapter.mjs';
import {findCodexExecutable} from './codex-binary.mjs';

// The MCP standard supports a server-owned icon in initialize.serverInfo.icons.
// Keep this small, self-contained and free of external URL/credential dependencies.
const iconBytes=readFileSync(new URL('../assets/theo-synapse-icon-64.png',import.meta.url));
if(iconBytes.length>8192||iconBytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')
 throw Error('INVALID_THEO_ICON_ASSET');
const iconDataUri='data:image/png;base64,'+iconBytes.toString('base64');

const response=value=>({content:[{type:'text',text:JSON.stringify(value)}]});
const error=e=>({isError:true,content:[{type:'text',text:JSON.stringify({error:e.message})}]});
const safely=fn=>async input=>{try{return response(await fn(input));}catch(e){return error(e);}};
export function makeServer({codexPath,workspace,fixtureCoordinator,remoteCoordinator,writeCoordinator=null,directCoordinator=null,internalRealCodexE2E=false,
 authState='not-configured',transportKind='local-stdio-only'}={}){
 if(internalRealCodexE2E&&!fixtureCoordinator)throw Error('REAL_E2E_REQUIRES_PRIVATE_COORDINATOR');
 if(remoteCoordinator&&fixtureCoordinator)throw Error('CONFLICTING_TASK_BACKENDS');
 const taskCoordinator=remoteCoordinator??fixtureCoordinator;
 const server=new McpServer({
  name:'theo-synapse',title:'Theo Synapse',version:'0.0.5',
  icons:[{src:iconDataUri,mimeType:'image/png',sizes:['64x64']}]
 });
 server.registerTool('standalone_capabilities',{description:'Read-only feature flags',annotations:{readOnlyHint:true,openWorldHint:false},inputSchema:{}},async()=>response({
  version:'0.0.5',productName:'Theo Synapse',realCodexTaskEnabled:Boolean(remoteCoordinator||fixtureCoordinator&&internalRealCodexE2E),
  taskStartEnabled:Boolean(taskCoordinator),fixtureTaskEnabled:Boolean(fixtureCoordinator&&!internalRealCodexE2E),
  writeEnabled:false,candidateWriteEnabled:Boolean(writeCoordinator),directEnabled:Boolean(directCoordinator),
  writeTarget:'isolated-candidate-only',authentication:authState,transport:transportKind
 }));
 server.registerTool('standalone_codex_probe',{description:'Read-only Codex App Server initialize handshake; never starts a turn',annotations:{readOnlyHint:true,openWorldHint:false},inputSchema:{}},async()=>{
  const adapter=new CodexAppServer(codexPath,workspace);
  try{const result=await adapter.connect();return response({connected:true,serverInfo:result?.serverInfo??null});}
  catch(e){return error(e);}finally{adapter.disconnect();}
 });
 // Real work is available ONLY through the private Unix-socket daemon (remoteCoordinator).
 // Synthetic and authorized real-turn fixtures remain injectable in isolated tests.
 if(taskCoordinator){
  const real=Boolean(remoteCoordinator);
  server.registerTool('standalone_list_projects',{
   description:real?'List explicitly registered read-only project IDs; no arbitrary filesystem paths':'List isolated test projects',
   annotations:{readOnlyHint:true,openWorldHint:false},inputSchema:{}
  },safely(()=>taskCoordinator.listProjects()));
  server.registerTool('standalone_task_start',{
   description:real?
    'Start ONE real Codex read-only task in an allowlisted project. Use only when user explicitly requests it. May consume ChatGPT Codex quota. No edits, network, approval escalation, or auto retry. Supply a unique request id, reuse the same id only for a retry. At most one active task and 8 tasks per UTC day.':
    (internalRealCodexE2E?'Private isolated real Codex read-only E2E':'Start a synthetic fixture task'),
   annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:true},inputSchema:{
    id:z.string().min(8).max(80).describe('Unique stable idempotency key for this user request'),
    projectId:z.string().min(1).max(64).describe('Exact id obtained from standalone_list_projects'),
    prompt:z.string().min(1).max(12288).describe('Read-only question about the registered project. Never include secrets.'),
    mode:z.literal('read_only')
   }
  },safely(input=>taskCoordinator.start(input)));
  server.registerTool('standalone_task_status',{
   description:'Read SQLite-persisted state of a previously started task; RUNNING, COMPLETED, UNKNOWN, etc.',
   annotations:{readOnlyHint:true,openWorldHint:false},inputSchema:{id:z.string()}
  },safely(({id})=>taskCoordinator.status(id)));
  server.registerTool('standalone_task_events',{
   description:'Read ordered progress events since cursor seq. Use after=last returned seq to page. Events are not proof of completed tests.',
   annotations:{readOnlyHint:true,openWorldHint:false},inputSchema:{id:z.string(),after:z.number().int().min(0).default(0)}
  },safely(({id,after})=>taskCoordinator.events(id,after)));
  server.registerTool('standalone_task_result',{
   description:'Read persisted final Codex answer with separate verification flags; do not treat providerFinished as owner approval.',
   annotations:{readOnlyHint:true,openWorldHint:false},inputSchema:{id:z.string()}
  },safely(({id})=>taskCoordinator.result(id)));
  server.registerTool('standalone_task_stop',{
   description:'Ask to interrupt a read-only task, only on explicit user instruction. An interrupt request is not proof of stopping.',
   annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false},inputSchema:{id:z.string()}
  },safely(({id})=>taskCoordinator.stop(id)));
 }
 // Owner-authorization write tools are NOT exposed unless trusted host
 // explicitly injects a write-enabled bridge. This remains OFF in live Tunnel.
 if(writeCoordinator){
  server.registerTool('standalone_write_request',{
   description:'Request ONE Owner-mediated Codex candidate-only edit. Native Mac Deny-by-default dialog is required. Never modifies original code or registered snapshot. Exact allowlist up to 3 files. One-time grant burned BEFORE execution.',
   annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false},
   inputSchema:{
    id:z.string().min(8).max(80),
    projectId:z.string().min(1).max(64),
    instruction:z.string().min(12).max(240),
    allowedFiles:z.array(z.string().min(1).max(220)).min(1).max(3)
   }
  },safely(x=>writeCoordinator.writePropose(x)));
  server.registerTool('standalone_write_status',{
   description:'Read pending Owner approval and isolated write attempt state. No grant token returned.',
   annotations:{readOnlyHint:true,openWorldHint:false},inputSchema:{id:z.string()}
  },safely(({id})=>writeCoordinator.writeStatus(id)));
  server.registerTool('standalone_write_events',{
   description:'Read sanitized write attempt progress after cursor seq.',
   annotations:{readOnlyHint:true,openWorldHint:false},
   inputSchema:{id:z.string(),after:z.number().int().min(0).default(0)}
  },safely(({id,after})=>writeCoordinator.writeEvents(id,after)));
  server.registerTool('standalone_write_result',{
   description:'Read verified isolated candidate paths only; changes are NOT applied to any source.',
   annotations:{readOnlyHint:true,openWorldHint:false},inputSchema:{id:z.string()}
  },safely(({id})=>writeCoordinator.writeResult(id)));
  server.registerTool('standalone_write_cancel',{
   description:'Cancel a pending Owner request or interrupt the candidate. No clean stop is assumed.',
   annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false},
   inputSchema:{id:z.string()}
  },safely(({id})=>writeCoordinator.writeCancel(id)));
 }
 // Direct execution is intentionally host-injected. The normal daemon/stdio path never supplies it.
 if(directCoordinator){
  server.registerTool('codex_turn_start',{description:'Start one host-bound Codex turn. Workspace and permissions are selected only by the trusted host; workspace_write requires separate Owner authorization.',annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:false,openWorldHint:false},inputSchema:z.object({task_id:z.string().min(8).max(80),iteration:z.number().int().positive().max(9999),instruction:z.string().min(1).max(12288),execution_mode:z.enum(['read_only','workspace_write']).default('read_only'),workspace_id:z.string().min(1).max(64).optional()}).strict()},safely(x=>directCoordinator.start(x)));
  server.registerTool('codex_turn_wait',{description:'Read the persisted result for one host-bound Codex turn. It does not grant permissions or start another run.',annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false},inputSchema:z.object({task_id:z.string().min(8).max(80),run_id:z.string().min(10).max(96),workspace_id:z.string().min(1).max(64).optional()}).strict()},safely(x=>directCoordinator.wait(x)));
 }
 return server;
}
if(process.argv[1]&&import.meta.url===new URL('file://'+process.argv[1]).href){
 const server=makeServer({codexPath:process.env.STANDALONE_CODEX_PATH??findCodexExecutable(),workspace:process.cwd()});
 await server.connect(new StdioServerTransport());
}
