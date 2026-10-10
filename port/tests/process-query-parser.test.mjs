/** Parse the ACTUAL emitted queries with Windows PowerShell 5.1; never execute them. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { buildIdentityQuery, buildProcessTableQuery } from './helpers/process-authority.mjs'
import { readFixtureDirectoryAcls } from './helpers/fixture-isolation.mjs'

function emittedAclQuery() {
  let script
  readFixtureDirectoryAcls("C:\\parser-only\\O'Brien-測試", {
    run(file, args) {
      assert.equal(file, 'powershell.exe')
      script = args.at(-1)
      return { status: 0, stdout: '', stderr: '' }
    },
  })
  assert.equal(typeof script, 'string')
  return script
}

function parseOnly(script) {
  // Base64 is data transport, not an unescaped PowerShell argument or execution.
  const payload = Buffer.from(script, 'utf8').toString('base64')
  const parser = [
    "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'",
    `$source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))`,
    '$tokens = $null; $errors = $null',
    '$ast = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)',
    '[pscustomobject]@{ version=$PSVersionTable.PSVersion.ToString(); edition=$PSVersionTable.PSEdition; errorCount=@($errors).Count; errors=@($errors | ForEach-Object { $_.ErrorId }); statementCount=$ast.EndBlock.Statements.Count } | ConvertTo-Json -Compress',
  ].join('\n')
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(parser, 'utf16le').toString('base64'),
  ], { encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stderr.trim(), '')
  const parsed = JSON.parse(result.stdout.trim())
  assert.match(parsed.version, /^5\.1\./u, 'this gate requires actual Windows PowerShell 5.1')
  assert.equal(parsed.edition, 'Desktop')
  return parsed
}

const windowsOnly = { skip: process.platform !== 'win32', timeout: 120_000 }

test('PowerShell 5.1 AST accepts all actual emitted query scripts without executing them', windowsOnly, async t => {
  for (const [label, script] of [
    ['identity', buildIdentityQuery(4242)],
    ['process table', buildProcessTableQuery()],
    ['ACL with escaped apostrophe and Unicode path', emittedAclQuery()],
  ]) {
    await t.test(label, () => {
      const parsed = parseOnly(script)
      t.diagnostic(`${label}: Windows PowerShell ${parsed.version} ${parsed.edition}; AST errors=${parsed.errorCount}`)
      assert.equal(parsed.errorCount, 0, JSON.stringify(parsed.errors))
      assert.equal(parsed.statementCount, 2, 'preference assignment and try/catch must remain separate statements')
    })
  }
})

test('PowerShell 5.1 AST rejects the old space-joined form of each emitted script', windowsOnly, async t => {
  for (const [label, script] of [
    ['identity negative control', buildIdentityQuery(4242)],
    ['process table negative control', buildProcessTableQuery()],
    ['ACL negative control', emittedAclQuery()],
  ]) {
    await t.test(label, () => {
      const parsed = parseOnly(script.replace(/\n/gu, ' '))
      t.diagnostic(`${label}: Windows PowerShell ${parsed.version} ${parsed.edition}; AST errors=${parsed.errorCount}; ${JSON.stringify(parsed.errors)}`)
      assert.ok(parsed.errorCount > 0, `${label}: old broken bytes must fail the real parser`)
    })
  }
})
