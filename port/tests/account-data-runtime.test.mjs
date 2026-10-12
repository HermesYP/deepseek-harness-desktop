import assert from 'node:assert/strict'
import test from 'node:test'
import {readFileSync} from 'node:fs'
import {accountSessionId,accountResponseMetadata,accountFailureReason} from '../src-tauri/runtime/account-data.mjs'
import {sameAccountSession,settledAccountDetail,accountNeedsRetry,openAccountPageInBrowser} from '../ui/account-data/client-state.mjs'
import {repairAccountDataRuntime,repairAccountDataClient} from '../scripts/lib/account-data-runtime.mjs'

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

test('reviewed Host and client transforms preserve authentic loader boundaries and refuse unknown inputs',()=>{
 const source=readFileSync(new URL('../../_upstream/packages/credentials/deepseek-account-platform/lib/index.js',import.meta.url),'utf8')
 const client=readFileSync(new URL('../../_upstream/packages/client/ui-settings-account/lib/client.js',import.meta.url),'utf8')
 const helper=readFileSync(new URL('../ui/account-data/client-state.mjs',import.meta.url),'utf8')
 const repaired=repairAccountDataRuntime(source,'0.1.7-rc.2')
 assert.ok(repaired.source.includes('portSessionId: accountSessionId'))
 assert.ok(repaired.source.includes('error.accountReason = "verification-required"'))
 assert.ok(repaired.source.includes('email: z.string().nullish()'))
 assert.ok(repaired.source.includes('profile identity is missing'))
 assert.throws(()=>repairAccountDataRuntime(source.replace('email: z.string(),','email: z.unknown(),'),'0.1.7-rc.2'))
 assert.throws(()=>repairAccountDataRuntime(source.replace('status: response.status','status: 200'),'0.1.7-rc.2'))
 const result=repairAccountDataClient(client,helper,'0.1.7-rc.2')
 assert.ok(result.source.startsWith('window.__ModuleLoader__.load({'))
 assert.ok(result.source.includes('return module.exports;'))
 assert.ok(result.source.includes('details: sameSession ? snapshot.details : void 0'))
 assert.ok(result.source.includes('accountRetry: "Retry account details"'))
 assert.throws(()=>repairAccountDataClient(client+'unreviewed',helper,'0.1.7-rc.2'))
 assert.throws(()=>repairAccountDataClient(client.replace('revision++;','revision += 2;'),helper,'0.1.7-rc.2'))
 assert.doesNotThrow(()=>repairAccountDataClient(client.replaceAll('C:\\Users\\Yoova\\OneDrive','D:\\CleanCheckout'),helper,'0.1.7-rc.2'),'build-location metadata must not reject the reviewed account semantics')
})
