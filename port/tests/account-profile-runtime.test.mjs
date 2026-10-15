import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire, registerHooks } from 'node:module'
import { repairAccountProfileRuntime } from '../scripts/lib/account-profile-runtime.mjs'
import * as cache from '../src-tauri/runtime/account-profile-cache.mjs'

const profile={status:'ready',value:{id:'fixture-user',name:'Fixture',contact:'masked-contact',avatarUrl:null}}
const root=mkdtempSync(join(tmpdir(),'dsh-profile-cache-'))
const originalHome=process.env.DSH_HOME
test.after(()=>{if(originalHome===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=originalHome})
test.beforeEach(()=>{process.env.DSH_HOME=mkdtempSync(join(root,'case-'))})
const file=()=>join(process.env.DSH_HOME,'cache','dsh-desktop-account-profile.json')

test('profile recovery uses only this grant and never stores the raw token',()=>{
 cache.persistAccountProfile('fixture-token-one',profile)
 assert.deepEqual(cache.loadPersistedAccountProfile('fixture-token-one'),profile)
 assert.equal(cache.loadPersistedAccountProfile('fixture-token-two'),undefined)
 assert.equal(readFileSync(file(),'utf8').includes('fixture-token-one'),false)
})
test('corrupt, oversized and invalid cached profiles fail closed',()=>{
 cache.persistAccountProfile('grant',profile)
 writeFileSync(file(),'{truncated')
 assert.equal(cache.loadPersistedAccountProfile('grant'),undefined)
 writeFileSync(file(),'x'.repeat(17000))
 assert.equal(cache.loadPersistedAccountProfile('grant'),undefined)
 cache.persistAccountProfile('grant',{status:'ready',value:{id:4,name:null,contact:null}})
 assert.equal(cache.loadPersistedAccountProfile('grant'),undefined)
})
test('a failed or invalid update preserves the last complete cache',()=>{
 cache.persistAccountProfile('grant',profile)
 cache.persistAccountProfile('grant',{status:'failed'})
 assert.deepEqual(cache.loadPersistedAccountProfile('grant'),profile)
 const raw=JSON.parse(readFileSync(file(),'utf8'));raw.profile.value.name={untrusted:true}
 writeFileSync(file(),JSON.stringify(raw))
 assert.equal(cache.loadPersistedAccountProfile('grant'),undefined)
})
test('overlay refuses unsupported versions and generated shapes',()=>{
 assert.throws(()=>repairAccountProfileRuntime('', 'unknown'))
 assert.throws(()=>repairAccountProfileRuntime('', '0.1.7-rc.2'))
 // Both reviewed release literals must be known: an empty body then fails the
 // SHAPE guard, never the version guard.
 for(const version of ['0.2.1-alpha.2','0.2.1-alpha.3']) assert.throws(()=>repairAccountProfileRuntime('',version),/Unreviewed account getProfile shape/,'a reviewed release literal must reach the shape guard')
})

const runtime=process.env.DSH_TEST_ACCOUNT_RUNTIME
const runtimeVersion=runtime ? JSON.parse(readFileSync(join(runtime,'package.json'),'utf8')).version : undefined
test('actual packaged getProfile answers cached data while its refresh remains pending', {skip:!runtime, timeout:5000},async()=>{
 const require=createRequire(join(runtime,'package.json'))
 const index=pathToFileURL(require.resolve('@deepseek-ai/dsh-deepseek-account-platform')).href
 const helper=new URL('./profile-cache.js',index).href
 const source=readFileSync(new URL(index),'utf8')
   const repaired=repairAccountProfileRuntime(source,runtimeVersion)
 assert.equal(repaired.changed,!source.includes('DSH_PORT_CACHED_PROFILE_REFRESH'))
   assert.equal(repairAccountProfileRuntime(repaired.source,runtimeVersion).changed,false)
   assert.throws(()=>repairAccountProfileRuntime(source.replace('\tasync getProfile(client) {','\tasync getProfile(client) {\n if (this.closed) return null;'),runtimeVersion), /Unreviewed (?:cached )?account getProfile (?:shape|semantics)/)
   assert.throws(()=>repairAccountProfileRuntime(repaired.source.replace('return cached;','return null;'),runtimeVersion), /Unreviewed cached account getProfile shape/)
 const hooks=registerHooks({load(url,context,next){
   if(url===index)return {format:'module',source:repaired.source,shortCircuit:true}
   if(url===helper)return {format:'module',source:readFileSync(new URL('../src-tauri/runtime/account-profile-cache.mjs',import.meta.url),'utf8'),shortCircuit:true}
   return next(url,context)
 }})
 try{
   const {default:Platform}=await import(index)
   const instance=Object.create(Platform.prototype)
   instance.detailsLifetime=new AbortController()
   let currentGrant={token:'grant'}
   instance.readCurrentGrant=async()=>currentGrant
   instance.detailHeaders=()=>({})
   let resolveRefresh,reads=0
   instance.getDetail=()=>{reads++;return new Promise(resolve=>{resolveRefresh=resolve})}
   instance.listeners=new Set()
   cache.persistAccountProfile('grant',profile)
   assert.deepEqual(await instance.getProfile({}),profile)
   assert.deepEqual(await instance.getProfile({}),profile)
   assert.equal(reads,1,'duplicate consumers share background refresh')
   resolveRefresh({status:'failed'})
   await instance.profileRefreshInFlight.promise
   assert.deepEqual(instance.lastProfile.profile,profile,'failed refresh cannot erase usable cached data')
   await instance.getProfile({})
   const pending=instance.profileRefreshInFlight.promise
   instance.detailsLifetime.abort()
   instance.detailsLifetime=new AbortController()
   instance.lastProfile=undefined
   resolveRefresh({status:'ready',value:{...profile.value,name:'obsolete'}})
   await pending
   assert.equal(instance.lastProfile,undefined,'retired grant cannot publish a late profile')
   // Use the packaged getDetail and HTTP classification for a rejected grant.
   // The intercepted fetch is the only request surface; no live account API.
   instance.getDetail=Platform.prototype.getDetail
   instance.origin='https://fixture.invalid'
   instance.requestTimeout=1000
   let expired=0
   instance.expireCredential=async(token,lifetime)=>{
     assert.equal(token,'grant')
     assert.equal(lifetime,instance.detailsLifetime)
     expired++
     currentGrant=null
     instance.invalidateDetails()
   }
   const fetchBefore=globalThis.fetch
   globalThis.fetch=async url=>{
     assert.equal(String(url),'https://fixture.invalid/auth-api/v0/users/current')
     return new Response(null,{status:401,headers:{'x-amzn-waf-action':'challenge'}})
   }
   try {
     assert.deepEqual(await instance.getProfile({}),profile)
     await instance.profileRefreshInFlight.promise
     assert.equal(expired,1,'cached presentation cannot suppress credential expiry')
     assert.equal(instance.lastProfile,undefined)
     assert.equal(await instance.getProfile({}),null,'an expired grant cannot restore cached identity')
   } finally {globalThis.fetch=fetchBefore}
 }finally{hooks.deregister()}
})

test('production staging pins both the transform and cache helper before sealing',()=>{
 const stage=readFileSync(new URL('../scripts/lib/runtime-payload.psm1',import.meta.url),'utf8')
 const build=readFileSync(new URL('../scripts/build.ps1',import.meta.url),'utf8')
 assert.ok(stage.indexOf('repairAccountProfileRuntime(readFileSync(accountPath')<stage.indexOf("writeFileSync(join(output, 'package.json')"))
 assert.ok(stage.includes("'account-profile-cache.mjs'"))
 assert.ok(build.includes("'account-profile-runtime.mjs'"))
 assert.ok(build.includes("$inputs['accountProfileCache']"))
})
