import {randomUUID} from 'node:crypto';
import {lstatSync,realpathSync,statSync} from 'node:fs';
import {resolve} from 'node:path';
import {TaskStore} from './task-store.mjs';

function validateProjects(projects) {
  const result=new Map();
  for (const [id,root] of Object.entries(projects)) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) throw Error('INVALID_PROJECT');
    const absolute=resolve(root), st=lstatSync(absolute), real=realpathSync.native(absolute);
    if (!st.isDirectory()||st.isSymbolicLink()||real!==absolute||statSync(real).uid!==process.getuid?.())
      throw Error('UNSAFE_PROJECT_ROOT');
    result.set(id,real);
  }
  return result;
}
export class TaskCoordinator {
  constructor({projects={},store=new TaskStore(),adapterFactory,maxDurationMs=15000}) {
    if (typeof adapterFactory !== 'function') throw Error('NO_ADAPTER_FACTORY');
    this.projects=validateProjects(projects);
    this.store=store;this.adapterFactory=adapterFactory;this.running=new Map();
    if (!Number.isInteger(maxDurationMs)||maxDurationMs<250||maxDurationMs>60000) throw Error('INVALID_DURATION');
    this.maxDurationMs=maxDurationMs;
  }
  // Load only OWNER-PROVISIONED registry changes; never replace a project during a run.
  refreshProjects(projects) {
    const updated=validateProjects(projects);
    const differs=updated.size!==this.projects.size||
      [...updated].some(([id,path])=>this.projects.get(id)!==path);
    if(!differs)return false;
    const active=this.store.db.prepare("SELECT COUNT(*) AS n FROM standalone_tasks WHERE state IN ('QUEUED','RUNNING','STOP_REQUESTED')").get().n;
    if(active!==0||this.running.size!==0)throw Error('REGISTRY_RELOAD_DEFERRED_BUSY');
    this.projects=updated;
    return true;
  }
  listProjects(){return [...this.projects.keys()].map(id=>({id}));}
  start({id=randomUUID(),projectId,prompt,mode='read_only'}) {
    if (!this.projects.has(projectId)) throw Error('PROJECT_NOT_REGISTERED');
    if (mode!=='read_only') throw Error('WRITE_NOT_AUTHORIZED');
    const res=this.store.reserve({id,projectId,prompt,mode});
    if(res.created)queueMicrotask(()=>{this.run(id,prompt).catch(()=>{});});
    return {id,created:res.created,state:res.run.state};
  }
  async run(id,prompt) {
    if(this.store.get(id)?.state!=='QUEUED') return;
    this.store.transition(id,'RUNNING');
    const run=this.store.get(id);
    const root=this.projects.get(run.project_id);
    let adapter=null;let timer=null;let terminal=false;
    try {
      adapter=this.adapterFactory({projectRoot:root,taskId:id});
      if(!adapter||typeof adapter.execute!=='function')throw Error('NO_ADAPTER');
      this.running.set(id,adapter);
      const timeout=new Promise((_,reject)=>{
        timer=setTimeout(()=>reject(Error('EXECUTION_TIMEOUT')),this.maxDurationMs);
      });
      const execute=adapter.execute({projectRoot:root,prompt,onEvent:event=>{
        if (event?.kind==='progress') {
          this.store.progress(id,typeof event.stage==='string'?event.stage.slice(0,64):'progress',String(event.text??''));
        } else if(event?.kind==='terminal') {
          const state={completed:'COMPLETED',failed:'FAILED',interrupted:'STOPPED'}[event.status];
          if (!state) throw Error('INVALID_TERMINAL');
          const prior=this.store.get(id);
          if (prior.state==='RUNNING'||prior.state==='STOP_REQUESTED') {
            if (prior.state==='STOP_REQUESTED' && state==='COMPLETED') throw Error('STOP_COMPLETION_AMBIGUOUS');
            this.store.transition(id,state,String(event.output??''));
          }
          terminal=true;
        } else if(event?.kind==='unavailable') throw Error('PROVIDER_UNAVAILABLE');
      }});
      await Promise.race([execute,timeout]);
      if(!terminal) throw Error('MISSING_TERMINAL_EVENT');
    } catch(e) {
      const current=this.store.get(id);
      if (current && ['QUEUED','RUNNING','STOP_REQUESTED'].includes(current.state)) {
        // Provider may still be writing. Never claim clean STOPPED/FAILED.
        this.store.transition(id,'UNKNOWN');
      }
    } finally {
      clearTimeout(timer);
      try {await adapter?.disconnect?.();} catch {}
      this.running.delete(id);
    }
  }
  status(id) {
    const r=this.store.get(id);
    if(!r)throw Error('TASK_NOT_FOUND');
    return {id:r.id,projectId:r.project_id,mode:r.mode,state:r.state,createdAt:r.created_at,updatedAt:r.updated_at};
  }
  events(id,after=0){return this.store.events(id,after);}
  result(id){return this.store.result(id);}
  async stop(id){
    const r=this.store.get(id);
    if(!r)throw Error('TASK_NOT_FOUND');
    if(r.state==='QUEUED'){this.store.transition(id,'STOPPED');return this.status(id);}
    if(r.state==='RUNNING')this.store.transition(id,'STOP_REQUESTED');
    if(this.store.get(id).state==='STOP_REQUESTED'){
      const adapter=this.running.get(id);
      if(!adapter){this.store.transition(id,'UNKNOWN');return this.status(id);}
      try {await adapter.stop?.();}catch{
        try{await adapter.disconnect?.();}catch{}
        if(this.store.get(id)?.state==='STOP_REQUESTED')this.store.transition(id,'UNKNOWN');
      }
    }
    return this.status(id);
  }
  close(){this.store.close();}
}
