/** Execute the authentic preserved client factory; mock only its framework/transport boundary. */
import assert from 'node:assert/strict'
import test from 'node:test'
import {readFileSync} from 'node:fs'
import {runInNewContext} from 'node:vm'
import {repairAccountDataClient} from '../scripts/lib/account-data-runtime.mjs'
import {accountUpstreamVersion,readAccountUpstream} from './helpers/account-upstream.mjs'

const base=readAccountUpstream('packages/client/ui-settings-account/lib/client.js')
const helper=readFileSync(new URL('../ui/account-data/client-state.mjs',import.meta.url),'utf8')
const fixed=process.env.DSH_TEST_ACCOUNT_CLIENT
 ? readFileSync(process.env.DSH_TEST_ACCOUNT_CLIENT,'utf8')
 : repairAccountDataClient(base,helper,accountUpstreamVersion).source
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done});return {promise,resolve}}
const flush=()=>new Promise(resolve=>setImmediate(resolve))
const session=id=>({status:'credential-stored',portSessionId:id,attempt:null,links:{usageUrl:'https://platform.deepseek.com/usage',topUpUrl:'https://platform.deepseek.com/top_up'}})
const first='11111111-1111-4111-8111-111111111111',second='22222222-2222-4222-8222-222222222222'
const profile={status:'ready',value:{id:'fixture-user',name:null,contact:'f***@example.invalid',avatarUrl:null}}
const balance={status:'ready',value:[{currency:'USD',balance:'12.34'}],bonusWallets:[]}

function harness(source,{onboarding=false}={}){
 const effects=[],registrations=[],profileReads=[],balanceReads=[],queue=[]
 const browserEvents=new Map(),browserOpens=[]
 let receive,ended=false,module,dictionaries,operations,accountComponent,onboardingRegistration
 const stream={
  [Symbol.asyncIterator](){return this},
  next(){if(queue.length)return Promise.resolve({value:queue.shift(),done:false});if(ended)return Promise.resolve({done:true});return new Promise(resolve=>{receive=resolve})},
  dispose(){ended=true;receive?.({done:true});return Promise.resolve()},
 }
 const store=initial=>{let value=initial;return {getSnapshot:()=>value,subscribe:()=>()=>{},set:next=>{value=next}}}
 const jsx=(type,props)=>({type,props})
 const framework={
  'react/jsx-runtime':{jsx,jsxs:jsx},
  react:{useRef:value=>({current:value}),useState:value=>[value,()=>{}],useEffect:()=>{},useLayoutEffect:()=>{}},
  'react-dom':{},'@deepseek-ai/dsh-client-store':{createSnapshotStore:store,shallowEqual:(a,b)=>Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(key=>a[key]===b[key])},
  '@deepseek-ai/dsh-client-ui-primitives':new Proxy({},{get:(_,key)=>String(key)}),
 }
 // Account-only cases omit the independent overlay. The onboarding case below
 // executes the real registration, controller and credit button as well.
 // 0.2.1-alpha.3 replaced the desktop gate with a `const desktop = ...` value;
 // the alpha.2 wording is kept so both reviewed releases stay executable here.
 const gate=source.includes('\t\t\tconst desktop = "dshDesktop" in globalThis;')
  ? ['\t\t\tconst desktop = "dshDesktop" in globalThis;','\t\t\tconst desktop = false;']
  : ['\t\t\tif ("dshDesktop" in globalThis) {','\t\t\tif (false) {']
 assert.equal(source.split(gate[0]).length,2)
 runInNewContext(onboarding?source:source.replace(gate[0],gate[1]),{
  dshDesktop:{},window:{
   __ModuleLoader__:{load:row=>{module=row.factory(name=>{assert.ok(name in framework);return framework[name]})}},
   addEventListener:(event,handler)=>browserEvents.set(event,handler),removeEventListener:event=>browserEvents.delete(event),
   open:(...args)=>browserOpens.push(args),
  },
  console,URL,Intl,Date,setTimeout,clearTimeout,
 })
 const read=pending=>{const request=deferred();pending.push(request);return request.promise}
 module.apply({
  get:()=>undefined,
  effect:callback=>{const dispose=callback();if(typeof dispose==='function')effects.push(dispose)},
  locale:{register:(_,value)=>{dictionaries=value;return ()=>{}},bind:()=>key=>dictionaries.en[key]??key,getSnapshot:()=>({active:'en'})},
  theme:{getTheme:()=>({active:{colorScheme:'dark'}})},on:()=>()=>{},
  configForms:{
   get:name=>store({status:'ready',writable:true,value:name==='ui-chat'?{}:{version:1,step:'credit',purpose:null,process:null,completion:null,usage:'compact',developerTools:false}}),
   describe:()=>({...store({error:null}),ensure:async()=>{}}),developerTools:{setEnabled:async()=>{}},
  },
  remote:{$stream:()=>stream,$on:()=>()=>{},session:{initializeDefaultModel:async()=>({ok:true})},account:{
   getProfile:()=>read(profileReads),getBalance:()=>read(balanceReads),getUnnotifiedBonuses:async()=>({ok:true,value:null}),
  }},
  slots:{inject:(_,callback)=>{const dispose=callback();if(typeof dispose==='function')effects.push(dispose)},register:(row,component)=>{
   registrations.push(row);if(row.name==='settings.section'){operations=row.inject();accountComponent=component}
   if(row.id==='desktop-onboarding')onboardingRegistration={row,component}
   return ()=>{}
  }},
 })
 return {
  profileReads,balanceReads,browserEvents,browserOpens,
  async frame(value){const frame={value,accept:()=>{}};if(receive){const resolve=receive;receive=undefined;resolve({done:false,value:frame})}else queue.push(frame);await flush()},
  snapshot:()=>operations.hooks.account.getSnapshot(),refresh:()=>operations.refreshAccount(),
  render:()=>accountComponent({t:key=>dictionaries.en[key]??key,useAccount:select=>select(operations.hooks.account.getSnapshot()),useTheme:select=>select({active:{colorScheme:'dark'}}),...operations}),
  renderOnboarding:()=>{
   assert.ok(onboardingRegistration,'the actual desktop overlay must register')
   const injected=onboardingRegistration.row.inject()
   const entry=onboardingRegistration.component({t:key=>dictionaries.en[key]??key,useAccount:select=>select(injected.hooks.account.getSnapshot()),useOnboarding:select=>select(injected.hooks.onboarding.getSnapshot()),...injected})
   return entry.type(entry.props)
  },
  async close(){for(const dispose of effects.reverse())await dispose();await flush()},
 }
}
const nodes=tree=>Array.isArray(tree)?tree.flatMap(nodes):tree&&typeof tree==='object'?[tree,...nodes(tree.props?.children)]:[]
const text=tree=>Array.isArray(tree)?tree.map(text).join(' '):tree&&typeof tree==='object'?text(tree.props?.children):String(tree??'')

test('real client keeps an in-flight wallet read and visible details across same-login identity notifications',async()=>{
 const app=harness(fixed)
 try{
  await app.frame(session(first));app.profileReads[0].resolve({ok:true,value:profile});await flush()
  await app.frame(session(first))
  assert.equal(app.snapshot().details.profile.value.contact,'f***@example.invalid')
  assert.equal(app.balanceReads.length,1,'same-session notification must not duplicate pending reads')
  app.balanceReads[0].resolve({ok:true,value:balance});await flush()
  assert.equal(app.snapshot().details.balance.value[0].balance,'12.34','the pending result remains admissible')
  assert.match(text(app.render()),/f\*\*\*@example\.invalid/,'validated contact is the identity fallback')
 }finally{await app.close()}
})

test('real client labels stale data, wires Retry to both reads, and drops data across grant rotation/sign-out',async()=>{
 const app=harness(fixed)
 try{
  await app.frame(session(first));app.profileReads[0].resolve({ok:true,value:profile});app.balanceReads[0].resolve({ok:true,value:balance});await flush()
  const refreshing=app.refresh()
  app.profileReads[1].resolve({ok:true,value:{status:'failed',reason:'verification-required'}})
  app.balanceReads[1].resolve({ok:true,value:{status:'failed',reason:'network'}});await refreshing;await flush()
  assert.equal(app.snapshot().details.balance.stale,true);assert.equal(app.snapshot().details.profile.stale,true)
  const tree=app.render();assert.match(text(tree),/Platform requires browser verification/)
  const retry=nodes(tree).find(node=>node.type==='Button'&&node.props.children==='Retry account details')
  assert.ok(retry);assert.equal(retry.props.disabled,false)
  retry.props.onClick();assert.equal(app.profileReads.length,3);assert.equal(app.balanceReads.length,3)
  await app.frame(session(second));assert.equal(app.snapshot().details,undefined)
  app.profileReads[2].resolve({ok:true,value:profile});app.balanceReads[2].resolve({ok:true,value:balance});await flush()
  assert.equal(app.snapshot().details,undefined,'late results from the old grant cannot appear under the new grant')
  app.profileReads[3].resolve({ok:true,value:{status:'failed',reason:'verification-required'}});app.balanceReads[3].resolve({ok:true,value:balance});await flush()
  assert.equal(app.snapshot().details.profile.status,'failed');assert.equal(app.snapshot().details.balance.status,'ready')
  await app.frame({status:'signed-out',portSessionId:null,attempt:null,links:session(first).links})
  assert.equal(app.snapshot().details,undefined)
 }finally{await app.close()}
})

test('the same production-client race fails against the original bundle',async()=>{
 const app=harness(base)
 try{
  await app.frame(session(first));app.profileReads[0].resolve({ok:true,value:profile});await flush()
  await app.frame(session(first));app.balanceReads[0].resolve({ok:true,value:balance});await flush()
  assert.equal(app.snapshot().details,undefined,'baseline demonstrates the actual regression rather than mirroring the fix')
 }finally{await app.close()}
})

test('the real onboarding credit button opens the browser without guests and refreshes only after return',async()=>{
 for(const [source,enabled] of [[base,false],[fixed,true]]){
  const app=harness(source,{onboarding:true})
  try{
   await app.frame(session(first))
   const credit=nodes(app.renderOnboarding()).find(node=>node.type?.name==='OnboardingCreditStep')
   assert.ok(credit)
   const button=nodes(credit.type(credit.props)).find(node=>node.type==='Button'&&node.props.children==='Add credits')
   assert.ok(button);assert.equal(button.props.disabled,!enabled)
   if(!enabled)continue
   button.props.onClick()
   assert.equal(app.browserOpens.length,1)
   assert.equal(app.browserOpens[0][0],'https://platform.deepseek.com/top_up')
   app.browserEvents.get('focus')();await flush();assert.equal(app.balanceReads.length,1)
   app.browserEvents.get('blur')();app.browserEvents.get('focus')();await flush()
   assert.equal(app.balanceReads.length,1,'wait for the pre-return reads to settle')
   app.profileReads[0].resolve({ok:true,value:profile});app.balanceReads[0].resolve({ok:true,value:balance});await flush()
   assert.equal(app.balanceReads.length,2,'the real injected action refreshes the wallet after return')
   app.profileReads[1].resolve({ok:true,value:profile});app.balanceReads[1].resolve({ok:true,value:balance});await flush()
   assert.equal(app.browserEvents.size,0)
  }finally{await app.close()}
 }
})
