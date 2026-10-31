// Portable owner diagnostics. Does not launch Codex, request access, or mutate files.
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readFileSync,existsSync,lstatSync} from 'node:fs';
import {codexExecutableInfo} from '../src/codex-binary.mjs';
import {loadReadOnlyRegistry} from '../src/readonly-registry.mjs';
import {verifyPortableBundle} from './verify-portable-bundle.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const checks=[];
const record=(name,fn)=>{
 try{
  const r=fn(),pass=r===true||r?.pass===true;
  checks.push({name,status:pass?'PASS':'FAIL',code:pass?'VERIFIED':r?.code??'NOT_READY'});
 }catch(e){
  const msg=e?.message;
  checks.push({name,status:'FAIL',code:/^[A-Z0-9_]{3,80}$/.test(msg??'')?msg:'CHECK_ERROR'});
 }
};
const pkg=JSON.parse(readFileSync(join(root,'package.json'),'utf8'));
record('macOS',()=>({pass:process.platform==='darwin',code:'MACOS_REQUIRED'}));
record('Node24_or_newer',()=>({pass:Number(process.versions.node.split('.')[0])>=24,code:'NODE24_REQUIRED'}));
record('Codex_executable_present',()=>{
 const result=codexExecutableInfo();
 return {pass:result.present,code:result.location};
});
record('npm_dependencies_installed',()=>{
 const mods=['@modelcontextprotocol/sdk','jose','zod'];
 return {pass:mods.every(name=>{
  const path=join(root,'node_modules',...name.split('/'),'package.json');
  if(!existsSync(path))return false;
  try{return JSON.parse(readFileSync(path,'utf8')).version===pkg.dependencies[name];}
  catch{return false;}
 }),code:'RUN_NPM_CI_OFFLINE_OR_APPROVED_NETWORK'};
});
record('portable_bundle_integrity',()=>{
 if(!existsSync(join(root,'release-manifest.json')))
  return {pass:false,code:'PORTABLE_ARCHIVE_NOT_INSTALLED'};
 const verified=verifyPortableBundle(root);
 return {pass:verified.verdict==='PASS',code:'BUNDLE_HASH_OR_CONTENT_MISMATCH'};
});
record('private_readonly_lab_initialized',()=>{
 const local=join(root,'.local');
 if(!existsSync(local))return {pass:false,code:'RUN_NPM_SETUP_READONLY'};
 const s=lstatSync(local);
 if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid()||
    (s.mode&0o077)!==0)return {pass:false,code:'PRIVATE_RUNTIME_PERMISSIONS'};
 const reg=loadReadOnlyRegistry(root);
 return {pass:Object.keys(reg.projects).includes('theo-lab'),code:'READONLY_LAB_NOT_REGISTERED'};
});
record('no_live_write_grant_or_release',()=>{
 const rt=join(root,'.local','theo-runtime');
 const files=['write-release.json','writes.sqlite','promotions.sqlite'];
 return {pass:files.every(f=>!existsSync(join(rt,f))),code:'WRITE_PERMISSION_OR_LEDGER_PRESENT'};
});
const failed=checks.filter(x=>x.status==='FAIL');
const report={
 product:'Theo Synapse',mode:'read-only',
 verdict:failed.length?'SETUP_INCOMPLETE':'READY_FOR_OWNER_TUNNEL_SETUP',
 checks,
 modelTurnStarted:false,writeGranted:false,
 externalTunnelNotConfiguredByThisTool:true,
 signedAndNotarized:false
};
console.log(JSON.stringify(report,null,2));
if(failed.length)process.exitCode=1;
