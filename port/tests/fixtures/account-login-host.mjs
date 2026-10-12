/** Opt-in product-profile PKCE qualification; no operator credentials or live platform requests. */
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {createHash,randomUUID} from 'node:crypto'
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs'
import {tmpdir,userInfo} from 'node:os'
import {resolve,join} from 'node:path'
import {createRequire,registerHooks} from 'node:module'
import {pathToFileURL} from 'node:url'
import {buildFixtureEnvironment,assertFixtureEnvironment,assertFixtureDirectoryAcls,defaultAclRunner} from '../helpers/fixture-isolation.mjs'

if(!process.argv[2])throw new Error('Expected an absolute staged runtime path')
const runtime=resolve(process.argv[2]),root=mkdtempSync(join(tmpdir(),'dsh-account-callback-')),home=join(root,'home'),project=join(home,'profiles/desktop')
assert.equal(assertFixtureDirectoryAcls(root,{run:defaultAclRunner,account:userInfo().username}).contained,true)
mkdirSync(project,{recursive:true})
const inherited={...process.env}
const built=buildFixtureEnvironment({inherited,root,home,control:{socket:`fixture-unused-${randomUUID()}`,token:randomUUID()}})
built.env.DSH_TELEMETRY_DISABLED='1';built.ownedKeys.push('DSH_TELEMETRY_DISABLED')
assert.deepEqual(assertFixtureEnvironment(built.env,{root,controlled:true,ownedKeys:built.ownedKeys,inherited}),[])
for(const name of Object.keys(process.env))delete process.env[name]
Object.assign(process.env,built.env)
process.chdir(project)
let origin='',init,exchanges=0,logouts=0,provider,account,releaseExchange,socket
let holdExchange=false
let fakeToken='dsh_fixture_not_a_real_credential',includeIdentity=true,balanceMode='ready',profileMode='challenge'
const server=createServer((req,res)=>{void (async()=>{
 let text='';for await(const part of req)text+=part
 let value=null
 if(req.url==='/auth-api/v0/users/current'){
  if(profileMode==='unauthorized'){res.writeHead(401).end();return}
  if(profileMode==='empty'){res.setHeader('content-type','application/json');res.end(JSON.stringify({code:0,data:{biz_code:0,biz_data:{id:'fixture-user',email:null,mobile:null,mobile_number:null,id_profile:null}}}));return}
  res.writeHead(202,{'content-type':'text/html','x-amzn-waf-action':'challenge'}).end();return
 }
 if(req.url==='/api/v0/users/get_user_summary'){
  value=balanceMode==='ready'?{normal_wallets:[{currency:'USD',balance:'12.34'}],bonus_wallets:[]}:{normal_wallets:[{currency:'USD',balance:'not-a-number'}],bonus_wallets:[]}
 }else
 if(req.url==='/auth-api/v0/dsh/auth_init'){
  init=JSON.parse(text)
  assert.equal(init.code_challenge_method,'S256');assert.equal(init.login_source,'desktop')
  value={authorize_url:`${origin}/dsh/authorize?authorize_id=fixture`,expires_in:60,authorize_id:'fixture'}
 }else if(req.url==='/auth-api/v0/dsh/auth_exchange'){
  const body=JSON.parse(text);exchanges++
  assert.equal(createHash('sha256').update(body.code_verifier).digest('base64url'),init.code_challenge)
  assert.equal(body.redirect_uri,init.redirect_uri);assert.equal(body.code,'fixture-code')
  if(holdExchange)await new Promise(resolve=>{releaseExchange=resolve})
  value={...(includeIdentity?{user:{id:'fixture-user',email:null,mobile:'fixture-masked-phone',mobile_number:null,id_profile:{name:'Fixture Account',picture:null}}}:{}),token:fakeToken,authorized_url:`${origin}/dsh/authorized`}
 }else if(!['/auth-api/v0/dsh/auth_cancel','/auth-api/v0/users/logout'].includes(req.url)){
  assert.fail(`unexpected platform request path ${req.url}`)
 }
 res.setHeader('content-type','application/json');res.end(JSON.stringify({code:0,data:{biz_code:0,biz_data:value}}))
 if(req.url==='/auth-api/v0/users/logout')logouts++
})().catch(()=>{res.writeHead(500).end()})})
const report={lane:'production-profile-account-callback',root,checks:{fixtureAcl:true,environmentContained:true},nativeWebViewAcceptance:false}
const wait=async check=>{const end=Date.now()+5000;while(Date.now()<end){const result=await check();if(result)return result;await new Promise(resolve=>setTimeout(resolve,10))}throw new Error('fixture phase deadline')}
const client={version:'0.1.7-rc.2',locale:'en',timezoneOffsetSeconds:0}
const traced=process.argv[3]==='trace'
const modules=[]
const hooks=traced&&registerHooks({load(url,context,next){const start=performance.now();const result=next(url,context);modules.push({url,ms:performance.now()-start});return result}})
if(traced)globalThis.__DSH_PORT_TRACE=[]
try{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${server.address().port}`
 writeFileSync(join(project,'package.json'),JSON.stringify({name:'dsh-fixture-desktop',private:true,dependencies:{},dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app','@dsh-port/dsh-desktop-updates-bundle']}}}))
 writeFileSync(join(project,'cordis.patch.yml'),`- id: deepseek-account\n  config:\n    platformOrigin: ${origin}\n    inferenceOrigin: ${origin}\n    allowLoopbackHttp: true\n    desktopPlatform: win32\n    logoutMaxRetries: 0\n`)
 const require=createRequire(join(runtime,'package.json'))
 const {loadProfileDirectory,loadLayeredEnv}=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')))
 const {runProfile}=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh/profile-boot')))
 const installAnchor=require.resolve('@deepseek-ai/dsh/package.json')
 const start=performance.now()
 provider=await runProfile({environment:loadLayeredEnv('dsh'),profile:'desktop',resolvedProfile:{profile:loadProfileDirectory('dsh',project,installAnchor),installAnchor},patchFiles:[],args:['--no-open','--port','19417']})
 report.profileReadyMs=Math.round(performance.now()-start)
 if(traced){writeFileSync(join(root,'startup-trace.json'),JSON.stringify({modules,fibers:globalThis.__DSH_PORT_TRACE},null,2)+'\n');hooks.deregister()}
 account=provider.ctx.deepseekAccount
 const hostOrigin=`http://127.0.0.1:${provider.ctx.webServer.port}`
 const auth=await fetch(provider.ctx.connection.authenticatedUrl(hostOrigin),{redirect:'manual'})
 const cookie=auth.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ')
 assert.ok(cookie);await auth.body?.cancel()
 const rpc=async(method,args)=>{
  const response=await fetch(`${hostOrigin}/api/${method}`,{method:'POST',headers:{'content-type':'application/json',cookie},body:JSON.stringify({type:'client-request',rpcId:randomUUID(),method,payload:{args}})})
  assert.equal(response.status,200);const reply=await response.json();assert.equal(reply.result.ok,true);return reply.result.value
 }
 const {default:WebSocket}=await import(pathToFileURL(require.resolve('ws')))
 const states=[],streamId=randomUUID()
 socket=new WebSocket(`${hostOrigin.replace('http:','ws:')}/api/remote.mux`,{headers:{cookie}})
 await new Promise((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject)})
 socket.on('message',text=>{const frame=JSON.parse(String(text));assert.equal(frame.streamId,streamId);assert.equal(frame.type,'item');states.push(frame.value)})
 socket.send(JSON.stringify({type:'open',streamId,endpoint:'account/watch',payload:{args:{}}}))
 await wait(()=>states.length)
 report.checks.authenticatedAccountStream=true
 const begin=async()=>{
  const opened=await rpc('account/startSignIn',{client,callbackOrigin:'http://127.0.0.1:55555',loginSource:'desktop'})
  return wait(()=>states.find(state=>state.attempt?.id===opened.attempt?.id&&state.attempt?.phase==='waiting-browser'))
 }
 const callback=(state=init.state)=>`${init.redirect_uri}?state=${encodeURIComponent(state)}&code=fixture-code`
 let state=await begin()
 report.checks.waitingBrowserStateDelivered=true
 assert.equal(new URL(init.redirect_uri).origin,hostOrigin);report.checks.ownedHostOrigin=true
 const invalid=await fetch(callback('incorrect-state'),{redirect:'manual'});assert.equal(invalid.status,400);await invalid.body?.cancel()
 const duplicate=await fetch(`${callback()}&state=${init.state}`,{redirect:'manual'});assert.equal(duplicate.status,400);await duplicate.body?.cancel()
 assert.equal(exchanges,0);report.checks.invalidStateAndDuplicateRejected=true
 await rpc('account/cancelSignIn',{attemptId:state.attempt.id})
 const cancelled=await fetch(callback(),{redirect:'manual'});assert.notEqual(cancelled.status,302);await cancelled.body?.cancel()
 assert.equal(exchanges,0);assert.equal(await account.resolveToken('https://api.deepseek.com'),undefined);report.checks.cancelledAttemptCannotCommit=true
 state=await begin();holdExchange=true
 const valid=fetch(callback(),{redirect:'manual'})
 await wait(()=>releaseExchange)
 const repeated=await fetch(callback(),{redirect:'manual'});assert.equal(repeated.status,410);await repeated.body?.cancel()
 releaseExchange();const response=await valid
 assert.equal(response.status,302);assert.equal(new URL(response.headers.get('location')).origin,origin);await response.body?.cancel()
 await wait(async()=>{const value=await account.getState();return value.attempt?.phase==='succeeded'})
 assert.equal(exchanges,1);assert.equal(await account.resolveToken(origin),fakeToken)
 assert.equal(await account.resolveToken('https://api.deepseek.com'),undefined,'fixture credentials must never reach production inference')
 const profile=await account.getProfile(client);assert.equal(profile.value.name,'Fixture Account')
 assert.equal(profile.value.contact,'fixture-masked-phone');report.checks.nullEmailPhoneOnlyIdentityAccepted=true
 report.checks.cookieFreeCallback=true;report.checks.pkceVerified=true;report.checks.singleCommit=true;report.checks.identityFromExchange=true
 const firstSession=(await account.getState()).portSessionId
 assert.match(firstSession,/^[0-9a-f-]{36}$/)
 assert.equal((await account.getState()).portSessionId,firstSession)
 await wait(()=>states.some(value=>value.portSessionId===firstSession))
 assert.equal((await rpc('account/getBalance',{client})).value[0].balance,'12.34')
 report.checks.sessionIdDeliveredByRealStream=true;report.checks.balanceIndependentFromProfileChallenge=true
 await account.signOut(client);await wait(()=>logouts===1)
 assert.equal((await account.getState()).portSessionId,null)
 includeIdentity=false;fakeToken='dsh_fixture_other_grant';holdExchange=false
 state=await begin();const next=await fetch(callback(),{redirect:'manual'});assert.equal(next.status,302);await next.body?.cancel()
 await wait(async()=>(await account.getState()).attempt?.phase==='succeeded')
 const secondSession=(await account.getState()).portSessionId;assert.notEqual(secondSession,firstSession)
 assert.deepEqual(await rpc('account/getProfile',{client}),{status:'failed',reason:'verification-required'})
 assert.equal((await account.getState()).status,'credential-stored','a WAF challenge must not expire a valid stored grant')
 report.checks.challengeReasonDeliveredByRealRpc=true;report.checks.noIdentityReuseAfterRelogin=true
 balanceMode='invalid';assert.deepEqual(await rpc('account/getBalance',{client}),{status:'failed',reason:'protocol'})
 report.checks.invalidBalanceNeverBecomesZero=true
 profileMode='empty';assert.deepEqual(await rpc('account/getProfile',{client}),{status:'failed',reason:'protocol'});report.checks.emptyProfileStillRejected=true
 profileMode='unauthorized';assert.equal(await rpc('account/getProfile',{client}),null)
 await wait(async()=>(await account.getState()).status==='signed-out')
 assert.equal((await account.getState()).portSessionId,null);report.checks.trueUnauthorizedStillExpiresCredential=true
 report.result='PASS'
}catch(error){report.result='FAIL';report.error=String(error?.stack??error);process.exitCode=1}
finally{
 releaseExchange?.();hooks&&hooks.deregister()
 socket?.close()
 await provider?.ctx.fiber.dispose()
 server.closeAllConnections();await new Promise(resolve=>server.close(resolve))
 writeFileSync(join(root,'receipt.json'),JSON.stringify(report,null,2)+'\n')
 console.log(JSON.stringify(report))
}
