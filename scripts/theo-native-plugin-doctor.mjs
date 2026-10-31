#!/usr/bin/env node
// Source-only native first-use readiness.  It never writes, starts a daemon,
// starts a task/model turn, or reads legacy Tunnel profiles or credentials.
import {homedir,userInfo} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {runNativePluginDoctor} from '../src/theo-native-plugin-doctor.mjs';

const home=(()=>{try{return userInfo().homedir;}catch{return homedir();}})();
const options={nativeCore:join(home,'Library/Application Support/Theo Synapse/core'),app:join(home,'Applications/Theo Synapse.app'),manifestPath:join(home,'Applications/Theo Synapse.app/Contents/Resources/core-manifest.json'),healthUrlFile:null,requireControlPlanePoll:false};
const usage='USAGE: theo-native-plugin-doctor.mjs [--native-core PATH] [--app PATH] [--health-url-file PATH --require-control-plane-poll]';
for(let index=2;index<process.argv.length;index++){
 const flag=process.argv[index];
 if(flag==='--require-control-plane-poll'){options.requireControlPlanePoll=true;continue;}
 if(!['--native-core','--app','--health-url-file'].includes(flag)||!process.argv[index+1]||process.argv[index+1].startsWith('--')){process.stderr.write(usage+'\n');process.exit(64);}
 const key={ '--native-core':'nativeCore','--app':'app','--health-url-file':'healthUrlFile'}[flag],value=resolve(process.argv[++index]);
 options[key]=value;
 if(key==='app')options.manifestPath=join(value,'Contents/Resources/core-manifest.json');
}
async function tunnelHealth(healthUrlFile){
 // The URL and all runtime key material remain file references: never read or print them.
 const run=spawnSync('tunnel-client',['health','--url-file',healthUrlFile,'--require-control-plane-poll','--json'],{stdio:['ignore','pipe','pipe'],encoding:'utf8',timeout:15000,maxBuffer:32768});
 // Parse only booleans; never forward raw provider output, URLs or credentials.
 if(run.error?.code==='ENOENT')return {status:'FAIL',code:'TUNNEL_CLIENT_NOT_INSTALLED'};
 if(run.error||run.status!==0)return {status:'FAIL',code:'TUNNEL_HEALTH_FAILED'};
 try{
  const state=JSON.parse(run.stdout);
  if(state.result==='ok'&&state.healthz?.ok===true&&state.readyz?.ok===true&&state.control_plane_poll?.ok===true)
   return {status:'PASS',code:'TUNNEL_CONTROL_PLANE_POLL_OK'};
 }catch{}
 return {status:'FAIL',code:'TUNNEL_HEALTH_UNVERIFIED'};
}
const report=await runNativePluginDoctor(options,{tunnelHealth});
process.stdout.write(JSON.stringify(report)+'\n');
process.exitCode=report.verdict==='LOCAL_TUNNEL_READY_CHATGPT_E2E_REQUIRED'?0:2;
