import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync,realpathSync,statSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {generateKeyPair,exportJWK,SignJWT} from 'jose';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const root=realpathSync.native(resolve('.'));
const entry=join(root,'src','http-entry.mjs');
const allowRoot=join(root,'.local');

test('Independent authenticated HTTP executable serves only read-only diagnostics and shuts down',async()=>{
 const dir=mkdtempSync(join(allowRoot,'http-entry-e2e-'));
 const config=join(dir,'config.json');
 const {publicKey,privateKey}=await generateKeyPair('RS256',{modulusLength:2048});
 const key=await exportJWK(publicKey);key.kid='entry-test';key.alg='RS256';key.use='sig';
 const issuer='https://auth.entry-e2e.example/';
 const audience='https://mcp.entry-e2e.example/mcp';
 writeFileSync(config,JSON.stringify({issuer,audience,jwks:{keys:[key]},allowedSubjects:['owner-e2e']}),
  {flag:'wx',mode:0o600});
 assert.equal(statSync(config).mode&0o077,0);
 const child=spawn(process.execPath,[entry],{
  cwd:root,env:{HOME:process.env.HOME,PATH:process.env.PATH,
   STANDALONE_HTTP_AUTH_CONFIG:config,STANDALONE_HTTP_PORT:'0'},
  stdio:['ignore','pipe','pipe'],shell:false
 });
 let output='',errors='',client;
 child.stderr.on('data',data=>{errors+=data.toString().slice(0,2000);});
 child.stdout.on('data',data=>{output+=data.toString().slice(0,2000);});
 const started=await Promise.race([
  new Promise((resolve,reject)=>{
   child.stdout.on('data',()=>{const match=output.match(/http:\/\/127\.0\.0\.1:(\d+)\/mcp/);
    if(match)resolve(Number(match[1]));});
   child.on('exit',code=>reject(Error('EARLY_EXIT_'+code+':'+errors)));
  }),
  new Promise((_,reject)=>setTimeout(()=>reject(Error('START_TIMEOUT')),3000))
 ]);
 try{
  const token=await new SignJWT({scope:'standalone:read'})
   .setProtectedHeader({alg:'RS256',kid:key.kid}).setIssuer(issuer).setAudience(audience)
   .setSubject('owner-e2e').setIssuedAt().setExpirationTime('5m').sign(privateKey);
  const url=new URL('http://127.0.0.1:'+started+'/mcp');
  const deny=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},
   body:JSON.stringify({jsonrpc:'2.0',id:1,method:'ping'})});
  assert.equal(deny.status,401);
  client=new Client({name:'independent-binary-e2e',version:'1'});
  const transport=new StreamableHTTPClientTransport(url,
    {requestInit:{headers:{Authorization:'Bearer '+token}}});
  await client.connect(transport);
  const tools=await client.listTools();
  assert.deepEqual(tools.tools.map(x=>x.name).sort(),
   ['standalone_capabilities','standalone_codex_probe']);
  const capabilities=await client.callTool({name:'standalone_capabilities',arguments:{}});
  const data=JSON.parse(capabilities.content[0].text);
  assert.equal(data.authentication,'jwt-verified');
  assert.equal(data.writeEnabled,false);
  assert.equal(data.transport,'localhost-streamable-http');
 }finally{
  await client?.close();
  child.kill('SIGTERM');
  const exitCode=await Promise.race([new Promise(resolve=>child.once('exit',resolve)),
   new Promise((_,reject)=>setTimeout(()=>reject(Error('STOP_TIMEOUT')),3000))]);
  assert.equal(exitCode,0,'Authenticated local HTTP process did not exit cleanly');
  rmSync(dir,{recursive:true,force:true});
 }
});
