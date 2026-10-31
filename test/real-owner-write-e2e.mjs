// Separate, explicit REAL Codex workspace-write acceptance gate.
// Never included in npm test. Must receive a physical Mac native Owner approval.
// Uses a NEW, completely disposable project under /private/tmp, NOT Chappy Signal.
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {setTimeout as pause} from 'node:timers/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {TaskBridge} from '../src/task-bridge.mjs';
import {startTaskDaemon} from '../src/task-daemon.mjs';
import {makeServer} from '../src/mcp.mjs';

const id='theo-real-write-e2e-20261028';
const projectId='owner-write-demo';
const mainRoot=resolve('.');
const resultFile=join(mainRoot,'.local','evidence','phase2-task-tools','REAL_WRITE_OWNER_E2E_20261028.json');
const root=mkdtempSync('/private/tmp/theo-live-write-e2e-');
const runtime=join(root,'.local','theo-runtime');
const folder=join(runtime,'projects',projectId);
const allowed='extension/demo.js';
const initial='export const LABEL = "BEFORE";\n';
const sha=b=>createHash('sha256').update(b).digest('hex');
const result={
 date:new Date().toISOString(),test:'NATIVE_OWNER_CLICK_AND_REAL_CODEX_CANDIDATE',
 projectId,sourceOriginal:'DISPOSABLE_PRIVATE_TMP_FIXTURE',
 ownerApproved:false,realCodexRunAttempted:false,writeToChappySound:false,
 writeToChappySnapshot:false,artifactPromoted:false,verdict:'NOT_RUN',state:null,
 eventsCount:0,changedFiles:[],issues:[]
};
let daemon=null,client=null,server=null;
const invoke=async(name,args={})=>{
 const r=await client.callTool({name,arguments:args});
 const value=JSON.parse(r.content[0].text);
 if(r.isError)throw Error(String(value.error).slice(0,90));
 return value;
};
try{
 if(existsSync(resultFile))throw Error('E2E_ONE_TIME_ALREADY_RECORDED');
 const dirs=[join(root,'.local'),runtime,join(runtime,'projects'),folder,join(folder,'extension')];
 for(const d of dirs)mkdirSync(d,{mode:0o700});
 writeFileSync(join(runtime,'projects.json'),
  JSON.stringify({schema:1,projects:{[projectId]:folder}}),{flag:'wx',mode:0o600});
 writeFileSync(join(folder,allowed),initial,{flag:'wx',mode:0o600});
 writeFileSync(join(folder,'README.md'),'Disposable Theo Synapse write authorization fixture.\n',
  {flag:'wx',mode:0o600});
 const originalSha=sha(readFileSync(join(folder,allowed)));
 daemon=await startTaskDaemon({root,enableCandidateWrites:true,maxDurationMs:1000});
 const bridge=new TaskBridge({root,autostart:false,timeout:9000});
 server=makeServer({codexPath:'/Users/THEO_PUBLIC_EXAMPLE/.local/bin/codex',workspace:root,
  remoteCoordinator:bridge,writeCoordinator:bridge});
 client=new Client({name:'theo-native-one-time-owner-acceptance',version:'1'});
 const [a,b]=InMemoryTransport.createLinkedPair();
 await Promise.all([server.connect(a),client.connect(b)]);
 const cap=await invoke('standalone_capabilities');
 if(!cap.candidateWriteEnabled||cap.writeEnabled)throw Error('UNEXPECTED_WRITE_CAPABILITIES');
 const request=await invoke('standalone_write_request',{
  id,projectId,allowedFiles:[allowed],
  instruction:'Change only extension/demo.js so LABEL equals AFTER. Do not edit any other file.'
 });
 if(!request.created||request.state!=='APPROVAL_PENDING')
  throw Error('WRITE_PROPOSAL_NOT_ACCEPTED');
 console.log('MAC_OWNER_APPROVAL_REQUESTED_FOR_DISPOSABLE_DEMO_ONLY');
 const deadline=Date.now()+185000;
 let current=null;
 while(Date.now()<deadline){
  current=await invoke('standalone_write_status',{id});
  if(['COMPLETED','REJECTED','DENIED','EXPIRED','UNKNOWN'].includes(current.state))break;
  await pause(350);
 }
 result.state=current?.state??'TIMEOUT';
 result.ownerApproved=Boolean(current?.grantConsumed);
 result.realCodexRunAttempted=result.ownerApproved;
 let events=[],cursor=0;
 for(let i=0;i<15;i++){
  const page=await invoke('standalone_write_events',{id,after:cursor});
  if(!page.length)break;
  events.push(...page);cursor=page.at(-1).seq;
 }
 result.eventsCount=events.length;
 const final=await invoke('standalone_write_result',{id});
 result.changedFiles=final.candidate?.changedFiles??[];
 const afterSha=sha(readFileSync(join(folder,allowed)));
 const cloneUnchanged=afterSha===originalSha;
 result.disposableSnapshotPreserved=cloneUnchanged;
 const candidate=join(runtime,'write-candidates',id,'extension','demo.js');
 const candidateValid=existsSync(candidate)&&
  /LABEL\s*=\s*['"]AFTER['"]/.test(readFileSync(candidate,'utf8'));
 result.candidateVerified=Boolean(final.candidate?.candidateVerified&&candidateValid);
 result.grantConsumed=final.grantConsumed;
 result.artifactPromoted=final.artifactsApplied===true;
 result.verdict=(
  result.state==='COMPLETED'&&result.candidateVerified&&
  result.disposableSnapshotPreserved&&!result.artifactPromoted&&result.grantConsumed
 )?'PASS':result.state==='DENIED'?'OWNER_DENIED':'FAIL';
 console.log('E2E_VERDICT',JSON.stringify({
  verdict:result.verdict,state:result.state,grantConsumed:result.grantConsumed,
  candidateVerified:result.candidateVerified,snapshotPreserved:cloneUnchanged
 }));
 if(result.verdict!=='PASS')process.exitCode=1;
}catch(e){
 result.issues.push(String(e?.message??e).slice(0,120));
 result.verdict='FAIL';
 process.exitCode=1;
}finally{
 try{await client?.close();}catch{}
 try{await server?.close();}catch{}
 try{await daemon?.stop();}catch{}
 try{
  writeFileSync(resultFile,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
 }catch(e){
  console.error('E2E_REPORT_SAVE_FAILED',String(e?.code??'ERROR'));
  process.exitCode=1;
 }
 // Only newly created fixture under /private/tmp. No source project deletion.
 rmSync(root,{recursive:true,force:true});
}
