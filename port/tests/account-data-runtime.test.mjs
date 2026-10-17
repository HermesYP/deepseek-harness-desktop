import assert from 'node:assert/strict'
import test from 'node:test'
import {readFileSync} from 'node:fs'
import {runInNewContext} from 'node:vm'
import {createRequire} from 'node:module'
import {join} from 'node:path'
import {accountSessionId,accountResponseMetadata,accountFailureReason} from '../src-tauri/runtime/account-data.mjs'
import {sameAccountSession,settledAccountDetail,accountNeedsRetry,openAccountPageInBrowser} from '../ui/account-data/client-state.mjs'
import {repairAccountDataRuntime,repairAccountDataClient} from '../scripts/lib/account-data-runtime.mjs'
import {accountUpstreamRoot,accountUpstreamVersion,readAccountUpstream} from './helpers/account-upstream.mjs'

test('random session identifiers rotate with credential lifetime and never encode a token',()=>{
 const first=new AbortController(),next=new AbortController()
 const id=accountSessionId(first,'fixture-grant')
 assert.match(id,/^[0-9a-f-]{36}$/)
 assert.equal(accountSessionId(first,'fixture-grant'),id);assert.notEqual(accountSessionId(next,'fixture-grant'),id)
 assert.equal(accountSessionId(first,undefined),null)
 assert.notEqual(accountSessionId(first,'changed-fixture-grant'),id,'rotation is detected even before a lifetime notification arrives')
 const state=session=>({status:'credential-stored',portSessionId:session})
 assert.equal(sameAccountSession(state(id),state(id)),true)
 assert.equal(sameAccountSession(state(id),state(accountSessionId(next,'fixture-grant'))),false)
 assert.equal(sameAccountSession(state(id),{status:'signed-out',portSessionId:null}),false)
 assert.equal(sameAccountSession({status:'credential-stored'},{status:'credential-stored'}),false)
})

test('failed refresh preserves an explicitly stale prior value only until its session is retired',()=>{
 const ready={status:'ready',value:[{currency:'USD',balance:'10.00'}]}
 const stale=settledAccountDetail(ready,{status:'failed',reason:'verification-required'})
 assert.equal(stale.value,ready.value);assert.equal(stale.stale,true);assert.equal(accountNeedsRetry({balance:stale}),true)
 assert.deepEqual(settledAccountDetail(undefined,{status:'failed'}),{status:'failed'})
 assert.equal(settledAccountDetail(stale,ready),ready);assert.equal(accountNeedsRetry({balance:ready}),false)
})

test('verification diagnostics allowlist metadata and exclude response bodies and cookies',()=>{
 const response=new Response('private body',{status:202,headers:{'content-type':'text/html; charset=utf-8','x-amzn-waf-action':'challenge','set-cookie':'private-cookie','x-debug':'private-value'}})
 assert.deepEqual(accountResponseMetadata(response),{contentType:'text/html',verification:'challenge'})
 assert.deepEqual(accountResponseMetadata(new Response(null,{headers:{'content-type':'secret/server-value','x-amzn-waf-action':'private-value'}})),{contentType:'other',verification:null})
 assert.equal(accountFailureReason({accountReason:'verification-required'}),'verification-required')
 assert.equal(accountFailureReason({code:'network',message:'secret'}),'network')
 assert.equal(accountFailureReason({code:'no-response',message:'secret'}),'network')
})

test('external account pages validate their destination and report a return only after leaving the app',()=>{
 const links={usageUrl:'https://platform.deepseek.com/usage',topUpUrl:'https://platform.deepseek.com/top_up'}
 const listeners=new Map(),opened=[];let returned=0
 const target={addEventListener:(event,handler)=>listeners.set(event,handler),removeEventListener:event=>listeners.delete(event),open:(...args)=>opened.push(args)}
 const release=openAccountPageInBrowser(links,'top-up',target,()=>{returned++})
 assert.deepEqual(opened,[['https://platform.deepseek.com/top_up','_blank','noopener,noreferrer']])
 listeners.get('focus')();assert.equal(returned,0,'an initial focus is not a return from the browser')
 listeners.get('blur')();listeners.get('focus')();assert.equal(returned,1);assert.equal(listeners.size,0)
 release();assert.equal(returned,1)
 for(const value of ['https://attacker.invalid/top_up','https://platform.deepseek.com/usage','https://user:secret@platform.deepseek.com/top_up','https://platform.deepseek.com/top_up?token=secret']){
  assert.throws(()=>openAccountPageInBrowser({...links,topUpUrl:value},'top-up',target,()=>{}))
 }
 const retired=openAccountPageInBrowser(links,'usage',target,()=>{returned++});retired();assert.equal(listeners.size,0)
 assert.throws(()=>openAccountPageInBrowser(links,'unknown',target,()=>{}))
})

test('actual repaired request preserves credential expiry ahead of WAF recovery and redacts transport failures',async()=>{
 const original=readAccountUpstream('packages/credentials/deepseek-account-platform/lib/index.js').replaceAll('\r\n','\n')
 const source=repairAccountDataRuntime(original,accountUpstreamVersion).source
 const errors=source.slice(source.indexOf('var PlatformAuthError'),source.indexOf('/**\n* Accept HTTPS'))
 const requestStart=source.indexOf('async function platformRequest(url, init, signal) {')
 const request=source.slice(requestStart,source.indexOf('\n/**\n* Accept a browser-accessible',requestStart))
 // 0.2.1-alpha.3 gates its failure reports through `callerCancelled(signal)` and
 // logs them with `console.error`; both are part of the exercised surface, so the
 // fixture slice must carry the helper and the stub must accept `error`.
 const helperStart=source.indexOf('function callerCancelled')
 const helpers=helperStart<0?'':source.slice(helperStart,requestStart)
 const require=createRequire(join(accountUpstreamRoot,'packages/credentials/deepseek-account-platform/lib/index.js'))
 let response,transportError=false
 const logs=[]
 const runtime=runInNewContext(`${errors}\n${helpers}\n${request}\n({platformRequest,AccountUnauthorizedError})`,{
  URL,Headers,Buffer,z:require('zod').z,accountResponseMetadata,
  fetch:async()=>{if(transportError)throw new Error('private-fixture-transport');return response},
  console:{info:(...values)=>logs.push(values),error:(...values)=>logs.push(values)},
 })
 const invoke=()=>runtime.platformRequest('https://fixture.invalid/auth-api/v0/users/current?private=query',{
  method:'GET',headers:{'x-dsh-auth-token':'private-fixture-grant'},
 },new AbortController().signal)
 response=new Response('private-fixture-html',{status:401,headers:{'x-amzn-waf-action':'challenge','set-cookie':'private-fixture-cookie'}})
 await assert.rejects(invoke(),error=>error instanceof runtime.AccountUnauthorizedError)
 assert.equal(response.bodyUsed,true,'unauthorized response is canceled')
 response=new Response('private-fixture-html',{status:202,headers:{'x-amzn-waf-action':'challenge'}})
 await assert.rejects(invoke(),error=>error.accountReason==='verification-required')
 assert.equal(response.bodyUsed,true,'challenge response is canceled')
 response=new Response(JSON.stringify({code:40003}),{status:200})
 await assert.rejects(invoke(),error=>error instanceof runtime.AccountUnauthorizedError)
 transportError=true
 await assert.rejects(invoke(),error=>error.code===(accountUpstreamVersion==='0.1.7-rc.2'?'network':'no-response'))
 assert.doesNotMatch(JSON.stringify(logs),/private-fixture|private=query/)
})

test('reviewed Host and client transforms preserve authentic loader boundaries and refuse unknown inputs',()=>{
 const source=readAccountUpstream('packages/credentials/deepseek-account-platform/lib/index.js')
 const client=readAccountUpstream('packages/client/ui-settings-account/lib/client.js')
 const helper=readFileSync(new URL('../ui/account-data/client-state.mjs',import.meta.url),'utf8')
 const repaired=repairAccountDataRuntime(source,accountUpstreamVersion)
 assert.ok(repaired.source.includes('portSessionId: accountSessionId'))
 assert.ok(repaired.source.includes('error.accountReason = "verification-required"'))
 assert.ok(repaired.source.includes('email: z.string().nullish()'))
 assert.ok(repaired.source.includes('profile identity is missing'))
 assert.throws(()=>repairAccountDataRuntime(source.replace('email: z.string(),','email: z.unknown(),'),accountUpstreamVersion))
 assert.throws(()=>repairAccountDataRuntime(source.replace('status: response.status','status: 200'),accountUpstreamVersion))
 const result=repairAccountDataClient(client,helper,accountUpstreamVersion)
 assert.ok(result.source.startsWith('window.__ModuleLoader__.load({'))
 assert.ok(result.source.includes('return module.exports;'))
 assert.ok(result.source.includes('details: sameSession ? snapshot.details : void 0'))
 assert.ok(result.source.includes('accountRetry: "Retry account details"'))
 assert.throws(()=>repairAccountDataClient(client+'unreviewed',helper,accountUpstreamVersion))
 assert.throws(()=>repairAccountDataClient(client.replace('revision++;','revision += 2;'),helper,accountUpstreamVersion))
 assert.doesNotThrow(()=>repairAccountDataClient(client.replaceAll('%USERPROFILE%\\OneDrive','D:\\CleanCheckout'),helper,accountUpstreamVersion),'build-location metadata must not reject the reviewed account semantics')
})

test('reviewed pins are version-exact: alpha.3 bytes are never approved by an alpha.2 entry',()=>{
 const host=readAccountUpstream('packages/credentials/deepseek-account-platform/lib/index.js')
 const client=readAccountUpstream('packages/client/ui-settings-account/lib/client.js')
 const helper=readFileSync(new URL('../ui/account-data/client-state.mjs',import.meta.url),'utf8')
 if(accountUpstreamVersion==='0.2.1-alpha.2')return
 // The explicit literals are the point: the alpha.2 pins must reject alpha.3 bytes.
 assert.throws(()=>repairAccountDataRuntime(host,'0.2.1-alpha.2'),/Unreviewed account-data (semantics|shape)/,'the host request pin may not be shared across releases')
 assert.throws(()=>repairAccountDataClient(client,helper,'0.2.1-alpha.2'),/Unreviewed account-data semantics/,'the client pins may not be shared across releases')
 // Both new alpha.3 anchors are guarded: a moved 401 branch and a changed
 // AccountSection signature must fail the review rather than pass silently.
 assert.throws(()=>repairAccountDataRuntime(host.replace('if (response.status === 401 && new Headers(init.headers).has("x-dsh-auth-token")) {','if (response.status === 403) {'),accountUpstreamVersion),/Unreviewed account-data (semantics|anchor)/)
 assert.throws(()=>repairAccountDataClient(client.replace('function AccountSection({ t, useAccount, useTheme, start, cancel, openPlatformPage, avatarFailed }) {','function AccountSection({ t }) {'),helper,accountUpstreamVersion),/Unreviewed account-data (semantics|anchor)/)
})

const previousRoot=process.env.DSH_UPSTREAM_ROOT_PREVIOUS
test('the alpha.2 entry still repairs the genuine alpha.2 bodies, response log included',{skip:!previousRoot},()=>{
 const read=relative=>readFileSync(join(previousRoot,relative),'utf8')
 const version=JSON.parse(read('package.json')).version
 assert.equal(version,'0.2.1-alpha.2','the previous-upstream fixture must be the alpha.2 checkout')
 const host=read('packages/credentials/deepseek-account-platform/lib/index.js')
 const client=read('packages/client/ui-settings-account/lib/client.js')
 const helper=readFileSync(new URL('../ui/account-data/client-state.mjs',import.meta.url),'utf8')
 const repaired=repairAccountDataRuntime(host,version)
 assert.ok(repaired.source.includes('error.accountReason = "verification-required"'))
 assert.ok(repaired.source.includes('console.info("[deepseek-account] response", { path, status: response.status, ...metadata });'),'the alpha.2 entry keeps its own response log')
 assert.throws(()=>repairAccountDataRuntime(repaired.source,version),/reviewed base once/)
 assert.ok(repairAccountDataClient(client,helper,version).source.includes('details: sameSession ? snapshot.details : void 0'))
})
