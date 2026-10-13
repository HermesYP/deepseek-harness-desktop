import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = dirname(fileURLToPath(import.meta.url))
const portBundle = await readFile(resolve(packageRoot, 'lib/client.js'), 'utf8')
const upstreamBundle = await readFile(resolve(packageRoot, '../../.upstream/packages/client/ui-settings-general/lib/client.js'), 'utf8')
const packageId = '@dsh-port/dsh-client-ui-updates'

function wrapper(source, expectedId) {
  const lines = source.split(/\r?\n/u)
  assert.equal(lines[0], 'window.__ModuleLoader__.load({')
  assert.equal(lines[1], `\tid: ${JSON.stringify(expectedId)},`)
  assert.equal(lines[2], '\tfactory: (require) => {')
  const returnLine = lines.findIndex(line => line.trim() === 'return module.exports;')
  assert.notEqual(returnLine, -1)
  return {
    opening: [lines[0], lines[2]],
    closing: lines.slice(returnLine, returnLine + 3),
  }
}

const actual = wrapper(portBundle, packageId)
const reference = wrapper(upstreamBundle, '@deepseek-ai/dsh-client-ui-settings-general')
assert.deepEqual(actual, reference)
console.log('Port client-loader opening and closing match the upstream built plugin.')
