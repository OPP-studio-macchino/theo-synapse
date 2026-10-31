import {test} from 'node:test';
import assert from 'node:assert/strict';
import {request as httpRequest} from 'node:http';
import {generateKeyPair,exportJWK,SignJWT} from 'jose';
import {mkdtempSync,mkdirSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {startLoopbackMcp} from '../src/http-mcp.mjs';
import {makeServer} from '../src/mcp.mjs';
import {TaskStore} from '../src/task-store.mjs';
import {TaskCoordinator} from '../src/task-coordinator.mjs';
import {FixtureCodexAdapter} from './fixture-adapter.mjs';

const issuer='https://auth.standalone-test.example/';
const audience='https://standalone-test.example/mcp';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const eventually=async(fn,pred,ms=2000)=>{
  const end=Date.now()+ms;
  while(Date.now()<end){const value=await fn();if(pred(value))return value;await delay(20);}
  throw Error('TEST_TIMEOUT');
};
async function setup(overrides={}){
  const {publicKey,privateKey}=await generateKeyPair('RS256',{modulusLength:2048});
  const key=await exportJWK(publicKey);key.kid='local-test-key';key.alg='RS256';key.use='sig';
  const jwks={keys:[key]};
  const auth={issuer,audience,jwks,allowedSubjects:['opp-test-owner']};
  const server=await startLoopbackMcp({auth,port:0,...overrides});
  const url=new URL('http://127.0.0.1:'+server.address().port+'/mcp');
  const mint=async({scope='standalone:read',iss=issuer,aud=audience,subject='opp-test-owner',
    expiry='5m',iat=true}={})=>{
    let jwt=new SignJWT({scope}).setProtectedHeader({alg:'RS256',kid:key.kid})
      .setIssuer(iss).setAudience(aud).setSubject(subject).setExpirationTime(expiry);
    if(iat)jwt=jwt.setIssuedAt();
    return jwt.sign(privateKey);
  };
  const client=async(token)=>{
    const c=new Client({name:'standalone-http-e2e',version:'1'});
    const t=new StreamableHTTPClientTransport(url,{requestInit:{
      headers:{Authorization:'Bearer '+token}
    }});
    await c.connect(t);
    return c;
  };
  return {auth,url,mint,client,server,close:()=>server.close()};
}

test('HTTP transport never starts without explicit authentication or on non-loopback interface',async()=>{
  await assert.rejects(()=>startLoopbackMcp({}),/AUTH_CONFIG_REQUIRED/);
  await assert.rejects(()=>startLoopbackMcp({host:'0.0.0.0',auth:{}}),/LOOPBACK_BIND_ONLY/);
  await assert.rejects(()=>startLoopbackMcp({auth:{issuer,audience,jwks:{keys:[{kty:'oct',k:'private'}]},allowedSubjects:['opp-test-owner']}}),/JWKS_PRIVATE_KEY_DENIED|JWKS_INVALID/);
  await assert.rejects(()=>startLoopbackMcp({auth:{issuer,audience,jwks:{keys:[]}}}),/OWNER_SUBJECT_ALLOWLIST_REQUIRED/);
});

test('HTTPS OAuth metadata and RFC bearer challenge; missing, wrong, expired and wrong-scope tokens denied',async()=>{
  const x=await setup();
  try{
    const metadata=await fetch(new URL('http://127.0.0.1:'+x.server.address().port+'/.well-known/oauth-protected-resource'));
    assert.equal(metadata.status,200);
    const doc=await metadata.json();
    assert.equal(doc.resource,audience);
    assert.deepEqual(doc.authorization_servers,[issuer]);
    const body=JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{
      protocolVersion:'2025-11-25',clientInfo:{name:'test',version:'1'},capabilities:{}
    }});
    const request=(token,init={})=>fetch(x.url,{
      method:'POST',headers:{'Content-Type':'application/json',
      ...(token?{Authorization:'Bearer '+token}:{}),...(init.headers??{})},body
    });
    const missing=await request();
    assert.equal(missing.status,401);
    assert.match(missing.headers.get('www-authenticate'),/resource_metadata=/);
    assert.equal((await request('bad-token')).status,401);
    assert.equal((await request(await x.mint({aud:'https://foreign.example/mcp'}))).status,401);
    assert.equal((await request(await x.mint({iss:'https://wrong.example/'}))).status,401);
    assert.equal((await request(await x.mint({subject:'someone-else'}))).status,401);
    assert.equal((await request(await x.mint({iat:false}))).status,401);
    assert.equal((await request(await x.mint({expiry:1}))).status,401);
    const read=await x.mint();
    const restrictedBody=JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',
      params:{name:'standalone_task_start',arguments:{}}});
    const restricted=await fetch(x.url,{method:'POST',headers:{Authorization:'Bearer '+read,
      'Content-Type':'application/json'},body:restrictedBody});
    assert.equal(restricted.status,403);
    assert.match(restricted.headers.get('www-authenticate'),/insufficient_scope/);
    const withOrigin=await request(read,{headers:{Origin:'https://malicious.example'}});
    assert.equal(withOrigin.status,403);
    const withForwarded=await request(read,{headers:{'X-Forwarded-Host':'evil.example'}});
    assert.equal(withForwarded.status,403);
    const wrongHostStatus=await new Promise((resolve,reject)=>{
      const req=httpRequest({hostname:'127.0.0.1',port:x.server.address().port,
        method:'POST',path:'/mcp',headers:{Host:'evil.example',
          Authorization:'Bearer '+read,'Content-Type':'application/json'}},res=>{
          res.resume();res.on('end',()=>resolve(res.statusCode));
        });
      req.on('error',reject);req.end(body);
    });
    assert.equal(wrongHostStatus,403);
  }finally{await x.close();}
});

test('Authenticated MCP over actual loopback HTTP discovers ONLY diagnostics; no real Codex run',async()=>{
  const x=await setup();
  let c;
  try{
    c=await x.client(await x.mint());
    const tools=await c.listTools();
    assert.deepEqual(tools.tools.map(v=>v.name).sort(),
      ['standalone_capabilities','standalone_codex_probe']);
    const response=await c.callTool({name:'standalone_capabilities',arguments:{}});
    assert.equal(response.isError,undefined);
    const capabilities=JSON.parse(response.content[0].text);
    assert.equal(capabilities.writeEnabled,false);
    assert.equal(capabilities.taskStartEnabled,false);
    assert.equal(capabilities.realCodexTaskEnabled,false);
    assert.equal(capabilities.authentication,'jwt-verified');
    assert.equal(capabilities.transport,'localhost-streamable-http');
  }finally{await c?.close();await x.close();}
});

test('Authenticated HTTP -> MCP -> fixture task -> progress -> SQLite result; run scope enforced',async()=>{
  const dir=realpathSync.native(mkdtempSync(join(tmpdir(),'standalone-http-')));
  const project=join(dir,'project');mkdirSync(project);
  const store=new TaskStore(join(dir,'journal.sqlite'));
  const coordinator=new TaskCoordinator({projects:{fixture:project},store,
    adapterFactory:()=>new FixtureCodexAdapter(),maxDurationMs:1000});
  const x=await setup({serverFactory:()=>makeServer({
    codexPath:'/nonexistent/codex',workspace:dir,fixtureCoordinator:coordinator
  })});
  let c,reader;
  try{
    reader=await x.client(await x.mint());
    const denied=await reader.callTool({name:'standalone_task_start',
      arguments:{id:'http-fixture-0001',projectId:'fixture',mode:'read_only',prompt:'test'}});
    // The SDK signals forbidden at transport level (not an MCP tool result).
    assert.fail('Read-only client unexpectedly started a task: '+JSON.stringify(denied));
  }catch(e){
    assert.match(String(e),/403|Forbidden|insufficient_scope|AUTHORIZATION_REQUIRED/);
    assert.equal(coordinator.store.get('http-fixture-0001'),null);
  }finally{await reader?.close();}
  try{
    c=await x.client(await x.mint({scope:'standalone:read standalone:run:read_only'}));
    const invoke=async(name,args={})=>{
      const result=await c.callTool({name:'standalone_'+name,arguments:args});
      if(result.isError)throw Error(result.content[0].text);
      return JSON.parse(result.content[0].text);
    };
    const start=await invoke('task_start',{id:'http-fixture-0002',
      projectId:'fixture',mode:'read_only',prompt:'Synthetic isolated fixture'});
    assert.equal(start.created,true);
    const status=await eventually(()=>invoke('task_status',{id:start.id}),
      r=>r.state==='COMPLETED');
    assert.equal(status.state,'COMPLETED');
    const events=await invoke('task_events',{id:start.id,after:0});
    assert.ok(events.some(e=>e.kind==='fixture_analysis'));
    const result=await invoke('task_result',{id:start.id});
    assert.equal(result.providerFinished,true);
    assert.equal(result.ownerAccepted,false);
    const replay=await invoke('task_start',{id:start.id,projectId:'fixture',
      mode:'read_only',prompt:'Synthetic isolated fixture'});
    assert.equal(replay.created,false);
    const outside=await c.callTool({name:'standalone_task_start',
      arguments:{id:'http-fixture-0003',projectId:'not_registered',
        mode:'read_only',prompt:'should be blocked'}});
    assert.equal(outside.isError,true);
  }finally{
    await c?.close();await x.close();coordinator.close();
    rmSync(dir,{recursive:true,force:true});
  }
});
