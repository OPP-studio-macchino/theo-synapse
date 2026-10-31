// Native-only first-use readiness checks.  This module never starts a daemon,
// task, or model turn, and it intentionally knows nothing about legacy roots.
import {createHash} from 'node:crypto';
import {existsSync,lstatSync,readdirSync,readFileSync,realpathSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {join,relative,resolve} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {TaskBridge} from './task-bridge.mjs';
import {loadReadOnlyRegistry} from './readonly-registry.mjs';

const EXPECTED_TOOLS=['standalone_capabilities','standalone_codex_probe','standalone_list_projects','standalone_task_events','standalone_task_result','standalone_task_start','standalone_task_status','standalone_task_stop'];
const MAX_MANIFEST_FILES=5000,MAX_WALK_ENTRIES=6000;
const hash=value=>createHash('sha256').update(value).digest('hex');
const safeCode=error=>/^[A-Z0-9_]{3,80}$/.test(error?.message??'')?error.message:'INSPECTION_FAILED';
const result=(status,code,extra={})=>({status,code,...extra});
const privateFile=path=>{
 const stat=lstatSync(path);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.uid!==process.getuid()||(stat.mode&0o077)!==0)throw Error('UNSAFE_FILE');
 return stat;
};
const privateDirectory=path=>{
 const stat=lstatSync(path);
 if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==process.getuid()||(stat.mode&0o077)!==0||realpathSync.native(path)!==path)throw Error('UNSAFE_DIRECTORY');
 return stat;
};

export function inspectNativeCore({nativeCore,manifestPath}){
 try{
  if(!existsSync(nativeCore))return result('FAIL','NATIVE_CORE_NOT_INSTALLED');
  if(!existsSync(manifestPath))return result('FAIL','CORE_MANIFEST_NOT_INSTALLED');
  privateDirectory(nativeCore); privateFile(manifestPath);
  const manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
  if(!manifest||manifest.schema!==1||!Array.isArray(manifest.files)||manifest.files.length<1||manifest.files.length>MAX_MANIFEST_FILES)throw Error('CORE_MANIFEST_INVALID');
  const expected=new Set();
  for(const entry of manifest.files){
   const path=entry?.path,segments=typeof path==='string'?path.split('/'):[];
   if(typeof path!=='string'||!path||path.length>240||! /^[A-Za-z0-9@._+~/-]+$/.test(path)||segments.includes('..')||segments.includes('.local')||!Number.isSafeInteger(entry.bytes)||entry.bytes<0||! /^[a-f0-9]{64}$/.test(entry.sha256)||expected.has(path))throw Error('CORE_MANIFEST_INVALID');
   const target=join(nativeCore,path);
   if(resolve(target)!==target)throw Error('CORE_MANIFEST_INVALID');
   privateFile(target);
   const data=readFileSync(target);
   if(data.length!==entry.bytes||hash(data)!==entry.sha256)throw Error('CORE_HASH_MISMATCH');
   expected.add(path);
  }
  let seen=0;
  const walk=dir=>{for(const entry of readdirSync(dir,{withFileTypes:true})){
   if(entry.name==='.local')continue;
   if(++seen>MAX_WALK_ENTRIES)throw Error('CORE_ENUMERATION_LIMIT');
   const target=join(dir,entry.name);
   if(entry.isSymbolicLink())throw Error('CORE_SYMLINK_DETECTED');
   if(entry.isDirectory())walk(target);
   else if(!entry.isFile()||!expected.has(relative(nativeCore,target)))throw Error('CORE_UNEXPECTED_FILE');
  }};
  walk(nativeCore);
  return result('PASS','CORE_MANIFEST_VERIFIED',{files:expected.size});
 }catch(error){return result('FAIL',safeCode(error));}
}

export function inspectNativeRegistry(nativeCore){
 try{
  if(!existsSync(nativeCore))return result('FAIL','NATIVE_CORE_NOT_INSTALLED');
  const registry=loadReadOnlyRegistry(nativeCore),projects=Object.keys(registry.projects).sort();
  if(projects.includes('chappy-signal'))throw Error('FORBIDDEN_NATIVE_PROJECT_REGISTERED');
  if(!projects.includes('theo-lab'))throw Error('NATIVE_REGISTRY_LAB_MISSING');
  return result('PASS','NATIVE_REGISTRY_READONLY',{projects});
 }catch(error){return result('FAIL',safeCode(error));}
}

export function inspectOptionalApp(app,{platform=process.platform,run=spawnSync}={}){
 if(!existsSync(app))return result('NOT_CHECKED','APP_NOT_INSTALLED');
 try{
  const stat=lstatSync(app);
  if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('APP_DIR_UNSAFE');
  if(platform!=='darwin')return result('NOT_CHECKED','APP_SIGNATURE_MACOS_REQUIRED');
  for(const args of [
   ['/usr/bin/codesign','--verify','--deep','--strict',app],
   ['/usr/bin/xcrun','stapler','validate',app],
   ['/usr/sbin/spctl','--assess','--type','execute',app]
  ]){
   const execution=run(args[0],args.slice(1),{stdio:['ignore','pipe','pipe'],encoding:'utf8',timeout:40000});
   if(execution?.error||execution?.status!==0)throw Error('APP_SIGNATURE_INVALID');
  }
  return result('PASS','APP_SIGNED_NOTARIZED');
 }catch(error){return result('FAIL',safeCode(error));}
}

export async function defaultDaemonPing(nativeCore){
 return await new TaskBridge({root:nativeCore,autostart:false,timeout:1200}).ping();
}

export async function defaultMcpProbe(nativeCore){
 const client=new Client({name:'theo-native-plugin-doctor',version:'0.1.0'});
 const transport=new StdioClientTransport({command:process.execPath,args:[join(nativeCore,'scripts','theo-task-entry.mjs')],cwd:nativeCore,env:{HOME:process.env.HOME??'',PATH:process.env.PATH??'/usr/bin:/bin',THEO_SCHEMA_PROBE:'1'}});
 try{
  await client.connect(transport);
  const tools=(await client.listTools()).tools.map(tool=>tool.name).sort();
  const reply=await client.callTool({name:'standalone_capabilities',arguments:{}});
  const capabilities=JSON.parse(reply.content?.[0]?.text??'{}');
  return {tools,capabilities,isError:Boolean(reply.isError)};
 }finally{await client.close();}
}

export async function inspectNativeRuntime(nativeCore,{daemonPing=defaultDaemonPing,mcpProbe=defaultMcpProbe}={}){
 let daemon,mcp;
 try{daemon=await daemonPing(nativeCore);}catch{return {daemon:result('FAIL','DAEMON_NOT_READY'),mcp:result('NOT_CHECKED','MCP_NOT_PROBED')};}
 const daemonResult=daemon?.alive===true&&daemon.mode==='read_only'?result('PASS','DAEMON_READONLY_READY'):result('FAIL','DAEMON_NOT_READONLY');
 try{
  mcp=await mcpProbe(nativeCore);
  const tools=Array.isArray(mcp?.tools)?mcp.tools.slice().sort():[];
  if(JSON.stringify(tools)!==JSON.stringify(EXPECTED_TOOLS)||tools.some(name=>/write/i.test(name)))throw Error('MCP_TOOLSET_INVALID');
  if(mcp.isError||mcp.capabilities?.writeEnabled!==false||mcp.capabilities?.candidateWriteEnabled!==false)throw Error('MCP_WRITE_CAPABILITY_PRESENT');
  return {daemon:daemonResult,mcp:result('PASS','MCP_EIGHT_READONLY_TOOLS',{toolCount:tools.length})};
 }catch(error){return {daemon:daemonResult,mcp:result('FAIL',safeCode(error))};}
}

export function inspectTunnelRequest({healthUrlFile,requireControlPlanePoll}){
 if(!healthUrlFile)return result('NOT_CHECKED','TUNNEL_HEALTH_URL_FILE_REQUIRED');
 if(!requireControlPlanePoll)return result('NOT_CHECKED','TUNNEL_CONTROL_PLANE_POLL_REQUIRED');
 try{privateFile(healthUrlFile);return result('PENDING','TUNNEL_HEALTH_REQUESTED');}
 catch(error){return result('FAIL',safeCode(error));}
}

export function classifyNativePluginVerdict(report){
 if([report.core,report.registry,report.runtime?.daemon,report.runtime?.mcp].some(item=>item?.status!=='PASS'))return 'SETUP_REQUIRED';
 if(report.app?.status==='FAIL'||report.tunnel?.status!=='PASS')return 'SETUP_REQUIRED';
 return 'LOCAL_TUNNEL_READY_CHATGPT_E2E_REQUIRED';
}

export async function runNativePluginDoctor(options,{daemonPing,mcpProbe,appInspector=inspectOptionalApp,tunnelHealth}={}){
 const report={schema:1,readOnly:true,credentialValuesIncluded:false,checks:{}};
 report.checks.core=inspectNativeCore(options);
 report.checks.registry=inspectNativeRegistry(options.nativeCore);
 report.checks.app=appInspector(options.app);
 report.checks.runtime=await inspectNativeRuntime(options.nativeCore,{daemonPing,mcpProbe});
 const requested=inspectTunnelRequest(options);
 report.checks.tunnel=requested.status==='PENDING'
  ? await tunnelHealth?.(options.healthUrlFile)??result('FAIL','TUNNEL_HEALTH_UNAVAILABLE')
  : requested;
 report.verdict=classifyNativePluginVerdict({core:report.checks.core,registry:report.checks.registry,app:report.checks.app,runtime:report.checks.runtime,tunnel:report.checks.tunnel});
 return report;
}

export {EXPECTED_TOOLS};
