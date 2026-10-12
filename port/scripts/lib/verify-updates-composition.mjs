/** Production-loader composition gate; no Host or renderer is started. */
import assert from 'node:assert/strict'
import {readFileSync,writeFileSync,mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {createRequire} from 'node:module'
import {pathToFileURL,fileURLToPath} from 'node:url'

export async function verifyUpdatesComposition(payloadRoot, profileDir) {
  const require=createRequire(join(resolve(payloadRoot),'package.json'))
  const {loadProfileDirectory,composeEntries}=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')))
  const profile=loadProfileDirectory('dsh',profileDir,require.resolve('@deepseek-ai/dsh/package.json'))
  assert.equal(profile.skippedBundles.length,0,'a selected profile bundle did not resolve')
  const warnings=[],entries=composeEntries(profile.layers.map(layer=>layer.patches),message=>warnings.push(message))
  const rows=[]
  const visit=entries=>{for(const entry of entries){rows.push(entry);if(entry.group&&Array.isArray(entry.config))visit(entry.config)}}
  visit(entries)
  const updates=rows.filter(row=>row.id==='dsh-port-ui-updates'),account=rows.find(row=>row.id==='ui-settings-account')
  assert.equal(updates.length,1,'the desktop Updates plugin must compose exactly once')
  assert.equal(updates[0].name,'@dsh-port/dsh-client-ui-updates')
  assert.notEqual(updates[0].disabled,true)
  assert.ok(account,'the Account Settings owner must remain composed')
  assert.notEqual(account.disabled,true,'Updates must not remove Account or the Settings launcher')
  assert.deepEqual(warnings,[],'production composition emitted missing/mismatched-entry warnings')
  return {profile,entries}
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const [payloadRoot,profileSource]=process.argv.slice(2)
  assert.ok(payloadRoot&&profileSource,'expected payload root and Rust profile source')
  const source=readFileSync(profileSource,'utf8'),block=source.match(/DESKTOP_PROFILE_BUNDLES:\s*&\[&str\]\s*=\s*&\[([^\]]*)\]/)
  assert.ok(block,'desktop profile bundle authority is missing')
  const bundles=[...block[1].matchAll(/"([^"]+)"/g)].map(match=>match[1]),profileDir=mkdtempSync(join(tmpdir(),'dsh-updates-compose-'))
  writeFileSync(join(profileDir,'package.json'),JSON.stringify({name:'dsh-updates-composition-gate',private:true,dsh:{profile:{bundles}}}))
  await verifyUpdatesComposition(payloadRoot,profileDir)
  console.log('Desktop Updates composition verified; Account Settings remains enabled.')
}
