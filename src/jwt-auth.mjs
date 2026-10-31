import {createLocalJWKSet, jwtVerify} from 'jose';

const SUPPORTED_ALGORITHMS=['RS256','ES256','EdDSA'];
const SCOPES=Object.freeze({READ:'standalone:read',RUN:'standalone:run:read_only'});

function requireHttps(urlValue,kind){
  if(typeof urlValue!=='string'||urlValue.length>512)throw Error(kind+'_INVALID');
  let u;
  try{u=new URL(urlValue);}catch{throw Error(kind+'_INVALID');}
  if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||u.hostname==='localhost'||u.hostname==='127.0.0.1')
    throw Error(kind+'_HTTPS_REQUIRED');
  return urlValue; // OAuth issuer/audience claims use exact, case-sensitive strings.
}
function publicJwks(jwks){
  if(!jwks||typeof jwks!=='object'||!Array.isArray(jwks.keys)||
     jwks.keys.length<1||jwks.keys.length>10)throw Error('JWKS_INVALID');
  for(const key of jwks.keys){
    if(!key||typeof key!=='object'||!['RSA','EC','OKP'].includes(key.kty)||
       ['d','p','q','k','dp','dq','qi','oth'].some(secret=>secret in key))throw Error('JWKS_PRIVATE_KEY_DENIED');
  }
  return jwks;
}
export {SCOPES};
export function createJwtAccessVerifier({issuer,audience,jwks,allowedSubjects,maximumLifetimeSeconds=900}={}){
  if(!Array.isArray(allowedSubjects)||allowedSubjects.length<1||allowedSubjects.length>10||
     allowedSubjects.some(x=>typeof x!=='string'||x.length<3||x.length>128))
    throw Error('OWNER_SUBJECT_ALLOWLIST_REQUIRED');
  const owners=new Set(allowedSubjects);
  const expectedIssuer=requireHttps(issuer,'ISSUER');
  const expectedAudience=requireHttps(audience,'AUDIENCE');
  if(!Number.isInteger(maximumLifetimeSeconds)||maximumLifetimeSeconds<60||maximumLifetimeSeconds>1800)
    throw Error('JWT_LIFETIME_INVALID');
  const keys=createLocalJWKSet(publicJwks(jwks));
  return async function verifyAccessToken(token,{scope=SCOPES.READ}={}){
    if(typeof token!=='string'||token.length<48||token.length>8192||
       !/^[A-Za-z0-9._-]+$/.test(token))throw Error('TOKEN_FORMAT_INVALID');
    let payload;
    try{
      ({payload}=await jwtVerify(token,keys,{
        issuer:expectedIssuer,audience:expectedAudience,algorithms:SUPPORTED_ALGORITHMS,
        clockTolerance:5,requiredClaims:['exp','iat','sub']
      }));
    }catch{throw Error('TOKEN_VERIFICATION_FAILED');}
    if(typeof payload.sub!=='string'||payload.sub.length<3||payload.sub.length>128||
       !Number.isInteger(payload.exp)||!Number.isInteger(payload.iat)||
       payload.exp-payload.iat>maximumLifetimeSeconds||payload.iat>Date.now()/1000+5)
      throw Error('TOKEN_CLAIMS_INVALID');
    if(!owners.has(payload.sub))throw Error('OWNER_SUBJECT_NOT_ALLOWED');
    if(typeof payload.scope!=='string'||payload.scope.length>1024)throw Error('TOKEN_SCOPE_INVALID');
    const granted=new Set(payload.scope.trim().split(/\s+/));
    if(!granted.has(scope))throw Error('TOKEN_SCOPE_DENIED');
    return {subject:payload.sub,scopes:[...granted]};
  };
}
