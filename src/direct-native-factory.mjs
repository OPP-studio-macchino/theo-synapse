// Explicit trusted-local host factory. This module is never selected by MCP.
import {DirectCoordinator,codexDirectAdapterFactory} from './direct-coordinator.mjs';
import {loadDirectWorkspaceRegistry} from './direct-workspace-registry.mjs';
import {requestDirectWriteApproval,requestDirectActionApproval} from './direct-owner-approval.mjs';

export function createOwnerApprovedDirectCoordinator({root,journalPath,codexExecutable,ownerApproval=requestDirectWriteApproval,ownerActionApproval=requestDirectActionApproval,adapterFactory,maxDurationMs=300000}={}){
 if(typeof root!=='string'||typeof journalPath!=='string'||typeof ownerApproval!=='function'||typeof ownerActionApproval!=='function')throw Error('DIRECT_NATIVE_FACTORY_ARGUMENTS_INVALID');
 const registry=loadDirectWorkspaceRegistry({standaloneRoot:root});
 if(!registry.ids.length)throw Error('DIRECT_WORKSPACE_NOT_REGISTERED');
 const directAdapterFactory=adapterFactory??codexDirectAdapterFactory({executable:codexExecutable,ownerActionApproval});
 const recheck=({workspaceId,workspaceRoot})=>{
  const current=loadDirectWorkspaceRegistry({standaloneRoot:root});
  return current.workspaces[workspaceId]===workspaceRoot;
 };
 return new DirectCoordinator({workspaces:registry.workspaces,journalPath,adapterFactory:directAdapterFactory,maxDurationMs,
  ownerAuthorization:(context,options)=>ownerApproval(context,options),authorizationRecheck:recheck});
}
