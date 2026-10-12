/** Explicit staged-product check. No account, production feed or installer is used. */
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs'
import {tmpdir,userInfo} from 'node:os'
import {join,resolve} from 'node:path'
import {createRequire,registerHooks} from 'node:module'
import {pathToFileURL} from 'node:url'
import {runInNewContext} from 'node:vm'
import {createHash} from 'node:crypto'
import {createServer} from 'node:net'
import {buildFixtureEnvironment,assertFixtureEnvironment,assertFixtureDirectoryAcls,defaultAclRunner} from '../helpers/fixture-isolation.mjs'
import {verifyUpdatesComposition} from '../../scripts/lib/verify-updates-composition.mjs'

assert.ok(process.argv[2],'provide the final staged runtime directory')
const runtime=resolve(process.argv[2]),root=mkdtempSync(join(tmpdir(),'dsh-updates-host-')),home=join(root,'home'),project=join(home,'profiles/desktop')
assert.equal(assertFixtureDirectoryAcls(root,{run:defaultAclRunner,account:userInfo().username}).contained,true)
mkdirSync(project,{recursive:true})
const inherited={...process.env},built=buildFixtureEnvironment({inherited,root,home})
built.env.DSH_TELEMETRY_DISABLED='1';built.ownedKeys.push('DSH_TELEMETRY_DISABLED')
assert.deepEqual(assertFixtureEnvironment(built.env,{root,ownedKeys:built.ownedKeys,inherited}),[])
for(const name of Object.keys(process.env))delete process.env[name]
Object.assign(process.env,built.env)
process.chdir(project)
const info=console.info
console.info=(...args)=>{if(typeof args[0]==='string'&&args[0].startsWith('dsh web:'))return;info(...args)}
const output=process.stdout.write.bind(process.stdout)
process.stdout.write=(chunk,...args)=>String(chunk).startsWith('dsh web:')?true:output(chunk,...args)
const report={lane:'staged-updates-host-and-client',root,runtime,checks:{fixtureAcl:true,environmentContained:true},nativeVisualAcceptance:false,installedUpdateAcceptance:false,mockedClientBoundaries:['native invoke','slots and locale adapters','React server render']}
let provider,clientFiber,clientDependencies
const wait=async check=>{const end=Date.now()+5000;while(Date.now()<end){if(check())return;await new Promise(resolve=>setTimeout(resolve,10))}throw new Error('client activation deadline')}
try {
 const require=createRequire(join(runtime,'package.json'))
 const {loadLayeredEnv}=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')))
 writeFileSync(join(project,'package.json'),JSON.stringify({name:'updates-host-fixture',private:true,dependencies:{},dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app','@dsh-port/dsh-desktop-updates-bundle']}}}))
 const installAnchor=require.resolve('@deepseek-ai/dsh/package.json'),{profile}=await verifyUpdatesComposition(runtime,project)
 report.checks.offlineComposition=true;report.checks.accountRemainsEnabled=true;report.checks.noPatchWarnings=true
 const reservation=createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve))
 const {runProfile}=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh/profile-boot')))
 provider=await runProfile({environment:loadLayeredEnv('dsh'),profile:'desktop',resolvedProfile:{profile,installAnchor},patchFiles:[],args:['--no-open','--port',String(port)]})
 const graph=provider.ctx.clientModules.graph()
 assert.ok(graph.entries.some(row=>row.id==='@dsh-port/dsh-client-ui-updates'))
 assert.ok(graph.entries.some(row=>row.id==='@deepseek-ai/dsh-client-ui-settings-account'))
 report.checks.loaderClientGraphContainsUpdates=true
 const origin=`http://127.0.0.1:${provider.ctx.webServer.port}`
 const auth=await fetch(provider.ctx.connection.authenticatedUrl(origin),{redirect:'manual'})
 const cookie=auth.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');assert.ok(cookie);await auth.body?.cancel()
 const row=graph.entries.find(row=>row.id==='@dsh-port/dsh-client-ui-updates')
 // The Host admits only graph-advertised immutable URLs with their exact rev;
 // an invented, unversioned combo URL intentionally returns 404.
 const response=await fetch(new URL(row.url,origin+'/'),{headers:{cookie}})
 assert.equal(response.status,200)
 const source=await response.text()
 const artifact=readFileSync(join(runtime,'node_modules/@dsh-port/dsh-client-ui-updates/lib/client.js'),'utf8').replace(/\/\/# sourceMappingURL=.*$/m,'').trim()
 assert.ok(source.includes(artifact),'the served factory must be the final staged artifact; its source-map reference is Host-owned')
 report.checks.authenticatedBundle200=true
 const uiRequire=createRequire(new URL('../../ui/package.json',import.meta.url)),React=uiRequire('react'),jsx=uiRequire('react/jsx-runtime'),renderer=uiRequire('react-dom/server')
 const storeUrl=pathToFileURL(require.resolve('@deepseek-ai/dsh-client-store')).href
 const buildRequire=createRequire(new URL('../../../_upstream/packages/client/store/package.json',import.meta.url))
 // In the product these client-only libraries are preloaded in the built shell.
 // Node's isolated fixture resolves them from that same pinned UI toolchain;
 // they intentionally do not belong to the Host's production dependency set.
 clientDependencies=registerHooks({resolve(specifier,context,next){
  if(context.parentURL===storeUrl&&['zustand/vanilla','zustand/middleware','zustand/shallow','immer'].includes(specifier))return {url:pathToFileURL(buildRequire.resolve(specifier)).href,shortCircuit:true}
  return next(specifier,context)
 }})
 const store=await import(storeUrl)
 const {Context}=await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')))
 const framework={'@deepseek-ai/dsh-client-store':store,'react/jsx-runtime':jsx},registered=[],nativeCalls=[],callbacks=new Map()
 let module,dictionaries,callbackId=0
 const configuration={channel:'stable',feedUrl:null,availableChannels:[],pinnedChannel:null,disabledReason:'missing-source'}
 const internals={transformCallback:callback=>{callbacks.set(++callbackId,callback);return callbackId},invoke:async(command)=>{
  nativeCalls.push(command)
  if(command==='shell_app_info')return {version:'0.1.7-rc.2'}
  if(command==='update_status')return {phase:'idle'}
  if(command==='update_configuration')return configuration
  if(command==='plugin:event|listen')return 1
  if(command==='plugin:event|unlisten')return undefined
  assert.fail(`unexpected native action ${command}`)
 }}
 runInNewContext(source,{__TAURI_INTERNALS__:internals,window:{__ModuleLoader__:{load:row=>{
  assert.equal(row.id,'@dsh-port/dsh-client-ui-updates');module=row.factory(name=>{assert.ok(name in framework,`unknown external ${name}`);return framework[name]})
 }}},console,URL,Set,Map,Date,setTimeout,clearTimeout})
 const ctx=new Context()
 ctx.provide('locale',{bind:()=>key=>dictionaries.en[key]??key,register:(_,value)=>{dictionaries=value;return ()=>{}}})
 ctx.provide('slots',{inject:(_,contribute)=>contribute(),register:(row,component)=>{registered.push({row,component});return ()=>{}}})
 clientFiber=ctx.plugin(module)
 await wait(()=>registered.some(value=>value.row.id==='updates'))
 const section=registered.find(value=>value.row.id==='updates'),actions=section.row.inject()
 await wait(()=>actions.hooks.updates.getSnapshot().configuration!==null)
 assert.equal(registered.filter(value=>value.row.name==='settings.launcher').length,0)
 const state=actions.hooks.updates.getSnapshot()
 assert.equal(state.configuration.disabledReason,'missing-source');assert.equal(state.checked,false)
 const html=renderer.renderToStaticMarkup(React.createElement(section.component,{...actions,t:key=>dictionaries.en[key]??key,useUpdates:select=>select(actions.hooks.updates.getSnapshot())}))
 assert.match(html,/no release source is packaged/);assert.match(html,/Not checked yet/);assert.doesNotMatch(html,/Up to date/)
 const betaOnly={...state,configuration:{...configuration,availableChannels:['beta'],disabledReason:'missing-channel'}}
 const betaHtml=renderer.renderToStaticMarkup(React.createElement(section.component,{...actions,t:key=>dictionaries.en[key]??key,useUpdates:select=>select(betaOnly)}))
 assert.match(betaHtml,/<fieldset>/,'a sole configured beta channel must remain selectable from an old stable preference')
 const betaInput=betaHtml.match(/<input[^>]*value="beta"[^>]*>/)?.[0]
 assert.ok(betaInput);assert.doesNotMatch(betaInput,/disabled/)
 await actions.check();assert.equal(nativeCalls.includes('update_check'),false)
 report.checks.cordisApplyRegisteredSection=true;report.checks.noCompetingLauncher=true;report.checks.disabledSourceExplained=true;report.checks.idleDoesNotClaimUpToDate=true;report.checks.disabledCheckMakesNoNativeRequest=true;report.checks.soleConfiguredChannelSelectable=true
 report.runtimeDescriptorSha256=createHash('sha256').update(readFileSync(join(runtime,'desktop-runtime.json'))).digest('hex')
 report.result='PASS'
} catch(error) {report.result='FAIL';report.error=String(error?.stack??error);process.exitCode=1}
finally {
 await clientFiber?.dispose()
 await provider?.ctx.fiber.dispose()
 clientDependencies?.deregister()
 console.info=info
 process.stdout.write=output
 writeFileSync(join(root,'receipt.json'),JSON.stringify(report,null,2)+'\n')
 console.log(JSON.stringify(report))
}
