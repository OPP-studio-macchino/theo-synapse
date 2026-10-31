// Read-only, fail-closed assessment for an Owner-approved Tunnel cutover.
// It never starts/stops a daemon, reads credentials, or changes any runtime file.
import {createHash} from 'node:crypto';
import {existsSync,lstatSync,readdirSync,readFileSync,realpathSync} from 'node:fs';
import {join,relative,resolve,sep} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {TaskBridge} from './task-bridge.mjs';
import {loadReadOnlyRegistry} from './readonly-registry.mjs';

const sha256=value=>createHash('sha256').update(value).digest('hex');
const privateFile=path=>{
 const s=lstatSync(path);
 if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.uid!==process.getuid()||(s.mode&0o077)!==0)throw Error('UNSAFE_FILE');
};
const privateDirectory=path=>{
 const s=lstatSync(path);
 if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&0o077)!==0||realpathSync.native(path)!==path)throw Error('UNSAFE_DIRECTORY');
};
const safeError=error=>/^[A-Z_]{3,80}$/.test(error?.message??'')?error.message:'INSPECTION_FAILED';
const check=(name,fn)=>{try{return {name,status:'PASS',...fn()};}catch(error){return {name,status:'BLOCKED',reason:safeError(error)};}};

function projectDigest(path){
 const visit=dir=>{privateDirectory(dir);return readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name)).flatMap(entry=>{
  const target=join(dir,entry.name);
  if(entry.isSymbolicLink())throw Error('PROJECT_SYMLINK_DETECTED');
  if(entry.isDirectory())return visit(target);
  if(!entry.isFile())throw Error('PROJECT_ENTRY_INVALID');
  privateFile(target);
  return [[relative(path,target),sha256(readFileSync(target))]];
 });};
 privateDirectory(path);
 return sha256(JSON.stringify(visit(path)));
}

function inspectRegistry(root,label){
 try{
  const registry=loadReadOnlyRegistry(root);
  const projects={};
  for(const [id,path] of Object.entries(registry.projects))projects[id]=projectDigest(path);
  return {label,status:'PASS',projects,runtime:registry.runtime,journalPath:registry.journalPath};
 }catch(error){return {label,status:'BLOCKED',reason:safeError(error),projects:{}};}
}

function inspectJobs(registry){
 if(registry.status!=='PASS')return {status:'BLOCKED',reason:'REGISTRY_UNAVAILABLE'};
 try{
  if(!existsSync(registry.journalPath))return {status:'PASS',active:0};
  privateFile(registry.journalPath);
  const db=new DatabaseSync(registry.journalPath,{readOnly:true});
  try{
   const row=db.prepare("SELECT COUNT(*) AS n FROM standalone_tasks WHERE state IN ('QUEUED','RUNNING','STOP_REQUESTED','UNKNOWN')").get();
   if(!Number.isSafeInteger(row?.n)||row.n<0)throw Error('JOURNAL_INVALID');
   return {status:row.n===0?'PASS':'BLOCKED',active:row.n,...(row.n===0?{}:{reason:'ACTIVE_OR_UNRESOLVED_JOBS'})};
  }finally{db.close();}
 }catch(error){return {status:'BLOCKED',reason:safeError(error)};}
}

async function inspectDaemon(root,registry){
 if(registry.status!=='PASS')return {status:'BLOCKED',reason:'REGISTRY_UNAVAILABLE'};
 try{
  const ping=await new TaskBridge({root,autostart:false,timeout:1200}).ping();
  return ping?.alive===true&&ping.mode==='read_only'?{status:'PASS',ready:true}:{status:'BLOCKED',reason:'DAEMON_NOT_READY'};
 }catch{return {status:'BLOCKED',reason:'DAEMON_NOT_READY'};}
}

function inspectManifest(core,manifestPath){
 return check('native_core_integrity',()=>{
  privateDirectory(core);privateFile(manifestPath);
  const manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
  if(!manifest||manifest.schema!==1||!Array.isArray(manifest.files)||manifest.files.length===0)throw Error('MANIFEST_INVALID');
  const expected=new Set();
  for(const entry of manifest.files){
   const segments=typeof entry?.path==='string'?entry.path.split('/'):[];
   if(!entry||typeof entry.path!=='string'||!/^[A-Za-z0-9@._+~/-]+$/.test(entry.path)||segments.includes('..')||segments[0]==='.local'||!Number.isSafeInteger(entry.bytes)||! /^[a-f0-9]{64}$/.test(entry.sha256))throw Error('MANIFEST_INVALID');
   const path=join(core,entry.path);if(resolve(path)!==path||expected.has(entry.path))throw Error('MANIFEST_INVALID');
   privateFile(path);const data=readFileSync(path);
   if(data.length!==entry.bytes||sha256(data)!==entry.sha256)throw Error('CORE_HASH_MISMATCH');
   expected.add(entry.path);
  }
  const walk=dir=>{for(const entry of readdirSync(dir,{withFileTypes:true})){if(entry.name==='.local')continue;const path=join(dir,entry.name);if(entry.isSymbolicLink())throw Error('CORE_SYMLINK_DETECTED');if(entry.isDirectory())walk(path);else if(!entry.isFile()||!expected.has(relative(core,path)))throw Error('CORE_UNEXPECTED_FILE');}};
  walk(core);return {files:expected.size};
 });
}

function inspectProfile(profile,legacyRoot,nativeCore){
 return check('official_tunnel_profile',()=>{
  privateDirectory(resolve(profile,'..'));privateFile(profile);
  const text=readFileSync(profile,'utf8');if(text.length>65536||text.includes('\0'))throw Error('PROFILE_INVALID');
  const lines=text.split(/\r?\n/);const commands=lines.filter(line=>/^\s*command:\s*/.test(line));
  if(commands.length!==1)throw Error('PROFILE_AMBIGUOUS');
  const match=commands[0].match(/^\s*command:\s*"([^"\r\n]+)"\s*$/);
  if(!match||/[\r\n]/.test(match[1]))throw Error('PROFILE_INVALID');
  const command=match[1];
  const legacy=`${legacyRoot}/scripts/theo-task-entry.mjs`,native=`${nativeCore}/scripts/theo-task-entry.mjs`;
  const channels=lines.filter(line=>/^\s*-\s*channel\s*:/.test(line));
  if(channels.length!==1||!/^\s*-\s*channel:\s*main\s*$/.test(channels[0]))throw Error('PROFILE_AMBIGUOUS');
  // The installed Mac Core lives under "Application Support/Theo Synapse":
  // keep the stdio script path shell-quoted without permitting extra argv.
  const allowed=[
   {suffix:` ${legacy}`,target:'LEGACY'},
   {suffix:` '${legacy}'`,target:'LEGACY'},
   {suffix:` ${native}`,target:'NATIVE'},
   {suffix:` '${native}'`,target:'NATIVE'}
  ];
  const selected=allowed.find(x=>command.endsWith(x.suffix));
  if(!selected)throw Error('PROFILE_EXECUTION_TARGET_UNKNOWN');
  const binary=command.slice(0,-selected.suffix.length);
  if(!['/opt/homebrew/bin/node','/usr/local/bin/node',`${process.env.HOME}/.local/bin/node`].includes(binary))throw Error('PROFILE_EXECUTABLE_UNEXPECTED');
  return {target:selected.target};
 });
}

// Owner policy: chappy-signal belongs to the legacy connection and must NEVER
// be registered or copied into the native Mac Core. This is an intentional
// exclusion, not a missing project to migrate.
const nativeRegistrationForbidden=new Set(['chappy-signal']);

function projectParity(legacy,native){
 const ids=[...new Set([...Object.keys(legacy.projects),...Object.keys(native.projects)])].sort();
 return ids.map(id=>{
  if(nativeRegistrationForbidden.has(id)){
   return id in native.projects
    ? {id,status:'BLOCKED',reason:'FORBIDDEN_NATIVE_PROJECT_REGISTERED'}
    : {id,status:'EXCLUDED',reason:'OWNER_EXCLUDED_FROM_NATIVE_MIGRATION'};
  }
  if(!(id in native.projects))return {id,status:'BLOCKED',reason:'NATIVE_PROJECT_MISSING'};
  if(!(id in legacy.projects))return {id,status:'BLOCKED',reason:'LEGACY_PROJECT_MISSING'};
  return legacy.projects[id]===native.projects[id]?{id,status:'PASS'}:{id,status:'BLOCKED',reason:'PROJECT_SNAPSHOT_SHA_MISMATCH'};
 });
}

export function classifyConnectionStatus(blocked,target){
 if(blocked.length)return 'BLOCKED';
 if(target==='LEGACY')return 'READY_FOR_OWNER_APPROVAL';
 if(target==='NATIVE')return 'POST_CUTOVER_VALIDATION_REQUIRED';
 return 'BLOCKED';
}

export async function runConnectionPreflight({legacyRoot,nativeCore,profile,manifestPath}){
 const legacy=inspectRegistry(legacyRoot,'legacy'),native=inspectRegistry(nativeCore,'native');
 const [legacyDaemon,nativeDaemon]=await Promise.all([inspectDaemon(legacyRoot,legacy),inspectDaemon(nativeCore,native)]);
 const report={schema:1,readOnly:true,credentialValuesIncluded:false,legacy:{projects:Object.keys(legacy.projects).sort(),daemon:legacyDaemon},native:{projects:Object.keys(native.projects).sort(),daemon:nativeDaemon},core:inspectManifest(nativeCore,manifestPath),jobs:{legacy:inspectJobs(legacy),native:inspectJobs(native)},projects:projectParity(legacy,native),tunnel:inspectProfile(profile,legacyRoot,nativeCore)};
 const blocked=[];
 for(const item of [legacy,native,report.core,report.jobs.legacy,report.jobs.native,report.tunnel,legacyDaemon,nativeDaemon,...report.projects])if(item.status==='BLOCKED')blocked.push(item.reason??item.name);
 report.verdict=classifyConnectionStatus(blocked,report.tunnel.target);
 report.reasons=[...new Set(blocked)];
 return report;
}
