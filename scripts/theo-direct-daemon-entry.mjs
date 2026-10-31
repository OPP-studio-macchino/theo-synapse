#!/usr/bin/env node
// Explicit Owner-local direct Codex service entry, never used by default.
// This is an opt-in native Core process, not an MCP-callable setup action.
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isNativeCoreRoot} from '../src/native-core.mjs';
import {loadDirectWorkspaceRegistry} from '../src/direct-workspace-registry.mjs';
import {createOwnerApprovedDirectCoordinator} from '../src/direct-native-factory.mjs';
import {startTaskDaemon} from '../src/task-daemon.mjs';
import {findCodexExecutable} from '../src/codex-binary.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
process.umask(0o077);
const stopError=e=>typeof e?.message==='string'&&/^[A-Z][A-Z0-9_]{2,80}$/.test(e.message)
 ? e.message : 'DIRECT_HOST_START_UNVERIFIED';
let service=null;
try{
 if(process.argv.length!==2)throw Error('DIRECT_HOST_ARGUMENTS_DENIED');
 if(!isNativeCoreRoot(root))throw Error('DIRECT_NATIVE_HOST_ONLY');
 // Registration requires a separate physical Mac approval; no default workspace.
 if(!loadDirectWorkspaceRegistry({standaloneRoot:root}).ids.length)
  throw Error('DIRECT_WORKSPACE_NOT_REGISTERED');
 const codexExecutable=findCodexExecutable();
 // The shared read-only TaskCoordinator is capped at 60 seconds.
 // DirectCoordinator independently retains its 5-minute turn ceiling.
 service=await startTaskDaemon({
  root,maxDurationMs:60000,
  directCoordinatorFactory:({root,journalPath})=>createOwnerApprovedDirectCoordinator({
   root,journalPath,codexExecutable
  })
 });
 console.error('THEO_DIRECT_NATIVE_HOST_READY');
}catch(error){
 console.error('THEO_DIRECT_HOST_REFUSED',stopError(error));
 process.exit(78);
}
let closing=false;
async function shutdown(){
 if(closing)return;
 closing=true;
 try{await service.stop();process.exit(0);}
 catch{process.exit(1);}
}
process.on('SIGTERM',shutdown);
process.on('SIGINT',shutdown);
process.on('uncaughtException',shutdown);
process.on('unhandledRejection',shutdown);
