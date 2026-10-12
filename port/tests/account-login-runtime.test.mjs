import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { desktopCallbackOrigin } from '../src-tauri/runtime/desktop-login.mjs'
import { repairAccountLoginRuntime } from '../scripts/lib/account-login-runtime.mjs'

test('native PKCE callback uses the Host listener; ordinary web callers retain their validated origin',()=>{
 const ctx={get:()=>({port:19417})}
 assert.equal(desktopCallbackOrigin(ctx,'http://127.0.0.1:55555','desktop',{DSH_DESKTOP_CONTROL_SOCKET:'fixture'}),'http://127.0.0.1:19417')
 assert.equal(desktopCallbackOrigin(ctx,'http://127.0.0.1:55555','web',{DSH_DESKTOP_CONTROL_SOCKET:'fixture'}),'http://127.0.0.1:55555')
 assert.equal(desktopCallbackOrigin(ctx,'http://127.0.0.1:55555','desktop',{}),'http://127.0.0.1:55555')
 for(const port of [undefined,0,-1,65536,'19417']) assert.throws(()=>desktopCallbackOrigin({get:()=>({port})},'unused','desktop',{DSH_DESKTOP_CONTROL_SOCKET:'fixture'}))
})
test('actual pinned provider retains caller/PKCE validation and refuses changed generated code',()=>{
 const source=readFileSync(new URL('../../_upstream/packages/credentials/deepseek-account-platform/lib/index.js',import.meta.url),'utf8')
 const result=repairAccountLoginRuntime(source,'0.1.7-rc.2')
 assert.equal(result.changed,true)
 assert.equal(repairAccountLoginRuntime(result.source,'0.1.7-rc.2').changed,false)
 assert.ok(result.source.includes('const validatedOrigin = loginOrigin(callbackOrigin);'))
 assert.ok(result.source.includes('timingSafeEqual'))
 assert.throws(()=>repairAccountLoginRuntime(source,'next'))
 assert.throws(()=>repairAccountLoginRuntime(source.replace('const origin = loginOrigin(callbackOrigin);','const origin = callbackOrigin;'),'0.1.7-rc.2'))
})

test('the official stage owns and pins the login transform before the inventory seal',()=>{
 const stage=readFileSync(new URL('../scripts/lib/runtime-payload.psm1',import.meta.url),'utf8')
 const build=readFileSync(new URL('../scripts/build.ps1',import.meta.url),'utf8')
 assert.ok(stage.indexOf('repairAccountLoginRuntime(readFileSync(accountPath')<stage.indexOf("writeFileSync(join(output, 'package.json')"))
 assert.ok(stage.includes("'desktop-login.mjs'"))
 assert.ok(build.includes("'account-login-runtime.mjs'"));assert.ok(build.includes("$inputs['desktopLogin']"))
})
