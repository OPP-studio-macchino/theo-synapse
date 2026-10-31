// Desktop host's bounded READ-ONLY state inspection. No auto-start, model or grant.
import {existsSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {spawnSync} from 'node:child_process';
import {loadReadOnlyRegistry} from '../src/readonly-registry.mjs';
import {TaskBridge} from '../src/task-bridge.mjs';
import {findCodexExecutable} from '../src/codex-binary.mjs';
import {publicDirectWorkspaceIds} from '../src/direct-workspace-registry.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
// Tunnel state cannot be inferred from the local daemon. Do not inspect a
// profile or credentials here; a separately authorized cutover must prove it.
const report={readOnly:true,running:false,mode:'stopped',registeredProjects:[],directWorkspaces:[],activeTasks:0,directActiveRuns:0,historyCount:0,codexInstalled:false,codexLogin:'NOT_CHECKED',writeEnabled:false,chatGPTConnection:'UNVERIFIED'};
try {
 const registry=loadReadOnlyRegistry(root);
 report.registeredProjects=Object.keys(registry.projects);
 for(const file of ['write-release.json','writes.sqlite','promotions.sqlite'])
  if(existsSync(join(registry.runtime,file)))throw Error('DESKTOP_UNEXPECTED_WRITE_STATE');
 if(existsSync(registry.journalPath)){
  const db=new DatabaseSync(registry.journalPath,{readOnly:true});
  try{
   report.activeTasks=db.prepare("SELECT COUNT(*) AS n FROM standalone_tasks WHERE state IN ('QUEUED','RUNNING','STOP_REQUESTED')").get().n;
   report.historyCount=db.prepare('SELECT COUNT(*) AS n FROM standalone_tasks').get().n;
  }finally{db.close();}
 }
 try{const ping=await new TaskBridge({root,autostart:false,timeout:1500}).ping();
  report.running=ping.alive===true&&['read_only','direct'].includes(ping.mode);report.mode=report.running?ping.mode:'stopped';
 }catch{}
 try{report.directWorkspaces=publicDirectWorkspaceIds({standaloneRoot:root});}catch{}
 const directFile=join(registry.runtime,'direct.sqlite');
 if(existsSync(directFile)){
  const db=new DatabaseSync(directFile,{readOnly:true});
  try{report.directActiveRuns=db.prepare("SELECT COUNT(*) AS n FROM direct_runs WHERE state IN ('APPROVAL_PENDING','QUEUED','RUNNING')").get().n;}finally{db.close();}
 }
 try{
  const codex=findCodexExecutable();report.codexInstalled=true;
  if(process.argv.includes('--login')){
   const p=spawnSync(codex,['login','status'],{encoding:'utf8',timeout:7000,maxBuffer:16384,stdio:['ignore','pipe','pipe']});
   const text=String(p.stdout??'')+String(p.stderr??'');
   report.codexLogin=p.status===0&&/logged in/i.test(text)?'LOGGED_IN':'LOGIN_REQUIRED';
  }
 }catch{}
 console.log(JSON.stringify(report));
}catch(e){console.log(JSON.stringify({error:/^[A-Z_]{3,80}$/.test(e.message)?e.message:'DESKTOP_INSPECTION_FAILED'}));process.exitCode=1;}
