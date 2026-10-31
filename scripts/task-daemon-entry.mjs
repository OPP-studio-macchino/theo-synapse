// Long-lived local read-only Codex task worker; Unix socket stays in private Standalone dir.
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {startTaskDaemon} from '../src/task-daemon.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
process.umask(0o077);
let service;
try{
 service=await startTaskDaemon({root,maxDurationMs:60000});
 console.error('THEO_READONLY_TASK_DAEMON_READY');
}catch(e){
 console.error('THEO_TASK_DAEMON_START_REFUSED',String(e?.message??'ERROR').replace(/[^A-Z0-9_]/g,'').slice(0,90));
 process.exit(78);
}
let closing=false;
const halt=async()=>{
 if(closing)return;
 closing=true;
 try{await service.stop();process.exit(0);}
 catch{process.exit(1);}
};
process.on('SIGINT',halt);
process.on('SIGTERM',halt);
process.on('uncaughtException',()=>{halt();});
process.on('unhandledRejection',()=>{halt();});
