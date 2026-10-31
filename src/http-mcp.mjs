import {createMcpExpressApp} from '@modelcontextprotocol/sdk/server/express.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {createJwtAccessVerifier,SCOPES} from './jwt-auth.mjs';
import {makeServer} from './mcp.mjs';
import {findCodexExecutable} from './codex-binary.mjs';

const MAX_BODY_BYTES=32768;
const sensitiveTools=new Set(['standalone_task_start','standalone_task_stop']);
function validPort(port){
 if(!Number.isInteger(port)||port<0||port>65535)throw Error('INVALID_LOCAL_PORT');
}
function authenticateHeader(header){
 if(typeof header!=='string'||header.length>8200||!/^Bearer [A-Za-z0-9._-]+$/i.test(header))
  throw Error('BEARER_TOKEN_REQUIRED');
 return header.slice(7);
}
export async function startLoopbackMcp({
  auth,port=0,host='127.0.0.1',serverFactory=()=>makeServer({
    codexPath:findCodexExecutable(),workspace:process.cwd(),
    authState:'jwt-verified',transportKind:'localhost-streamable-http'
  })
}={}){
 if(host!=='127.0.0.1')throw Error('LOOPBACK_BIND_ONLY');
 validPort(port);
 if(!auth||typeof auth!=='object'||typeof serverFactory!=='function')throw Error('AUTH_CONFIG_REQUIRED');
 const {issuer,audience,jwks,allowedSubjects}=auth;
 const verify=createJwtAccessVerifier({issuer,audience,jwks,allowedSubjects});
 const resource=new URL(audience);
 if(resource.pathname!=='/mcp'||resource.search||resource.hash)throw Error('INVALID_MCP_RESOURCE');
 const metadataUrl=new URL('/.well-known/oauth-protected-resource',resource).toString();
 const app=createMcpExpressApp({host});
 app.disable('x-powered-by');
 app.use((req,res,next)=>{
   res.setHeader('Cache-Control','no-store');
   res.setHeader('X-Content-Type-Options','nosniff');
   // Node MCP clients do not need browser Origin or proxy override headers.
   if(req.headers.origin||req.headers['x-forwarded-host']||req.headers['x-forwarded-proto'])
     return res.status(403).json({error:'ORIGIN_NOT_PERMITTED'});
   next();
 });
 const metadata={
  resource:audience,authorization_servers:[issuer],
  scopes_supported:[SCOPES.READ,SCOPES.RUN]
 };
 app.get('/.well-known/oauth-protected-resource',(req,res)=>res.json(metadata));
 app.get('/.well-known/oauth-protected-resource/mcp',(req,res)=>res.json(metadata));
 const challenge=(res,scope,errorName='invalid_token',status=401)=>{
  res.setHeader('WWW-Authenticate',
   'Bearer resource_metadata="'+metadataUrl+'", scope="'+scope+'", error="'+errorName+'"');
  return res.status(status).json({error:'AUTHORIZATION_REQUIRED'});
 };
 app.all('/mcp',async(req,res)=>{
  const scope=req.method==='POST'&&
    req.body?.method==='tools/call'&&sensitiveTools.has(req.body?.params?.name)
    ?SCOPES.RUN:SCOPES.READ;
  let identity;
  try{
   const token=authenticateHeader(req.headers.authorization);
   identity=await verify(token,{scope});
  }catch(e){
   return challenge(res,scope,e.message==='TOKEN_SCOPE_DENIED'?'insufficient_scope':'invalid_token',
    e.message==='TOKEN_SCOPE_DENIED'?403:401);
  }
  if(req.method!=='POST'){
   res.setHeader('Allow','POST');
   return res.status(405).json({error:'METHOD_NOT_ALLOWED'});
  }
  if(!req.is('application/json'))return res.status(415).json({error:'JSON_REQUIRED'});
  const bytes=Buffer.byteLength(JSON.stringify(req.body??null));
  if(bytes>MAX_BODY_BYTES)return res.status(413).json({error:'BODY_TOO_LARGE'});
  if(!req.body||typeof req.body!=='object'||Array.isArray(req.body))
    return res.status(400).json({error:'INVALID_MCP_REQUEST'});
  // Each request gets an isolated stateless MCP server, no sessions to hijack.
  const mcp=serverFactory();
  const transport=new StreamableHTTPServerTransport({
    sessionIdGenerator:undefined,
    enableJsonResponse:true
  });
  req.auth={clientId:'standalone-authorized-client',scopes:identity.scopes,
    token:undefined,extra:{subject:identity.subject}};
  try{
    await mcp.connect(transport);
    await transport.handleRequest(req,res,req.body);
  }catch{
    if(!res.headersSent)res.status(500).json({error:'MCP_REQUEST_FAILED'});
  }finally{
    await Promise.allSettled([transport.close(),mcp.close()]);
  }
 });
 app.use((err,req,res,next)=>{
  if(res.headersSent)return next(err);
  return res.status(400).json({error:'INVALID_JSON_REQUEST'});
 });
 const httpServer=await new Promise((resolve,reject)=>{
  const listening=app.listen(port,host);
  listening.once('error',reject);
  listening.once('listening',()=>resolve(listening));
 });
 return {
   address:()=>({host,port:httpServer.address().port,path:'/mcp',transport:'Streamable HTTP',authenticated:true}),
   close:()=>new Promise((resolve,reject)=>httpServer.close(e=>e?reject(e):resolve())),
   // Exposed for local TEST purposes; never export network-facing listener settings.
   httpServer
 };
}
