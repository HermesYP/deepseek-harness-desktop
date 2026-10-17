// Repository hygiene gate: fail when a tracked file contains identifying local
// paths, a launch-token-shaped URL, or a credential-store artifact. This is the
// forward guard for the 2026-10 evidence leak; it runs in CI and can be run
// locally with `node scripts/check-repo-hygiene.mjs`.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean)

const RULES = [
  {
    name: 'personal profile path',
    text: /Users[\\/]+Yoova\b/i,
    hint: 'replace the path root with a placeholder or a repository-relative path',
  },
  {
    name: 'launch-token-shaped URL',
    text: /[?&]token=[A-Za-z0-9_-]{16,}/u,
    hint: 'redact the token as <redacted>; test fixtures are allowlisted below',
  },
  {
    name: 'tracked credential-store artifact',
    file: /(^|\/)(\.credentials\.yaml|\.anonymous-user-id)$/u,
    hint: 'harness homes and credential stores are never tracked',
  },
  {
    name: 'leaked evidence directory',
    file: /(^|\/)docs\/evidence\/port-sessions\//u,
    hint: 'evidence captured against a real session must not be committed',
  },
]

// Real fixtures that intentionally contain token-shaped dummy values, plus this
// scanner itself (which necessarily spells the patterns it looks for).
const ALLOWLIST = new Set([
  'scripts/check-repo-hygiene.mjs',
  'port/tests/fixture-isolation.test.mjs',
  'port/tests/fixtures/account-login-host.mjs',
  'port/tests/native-cdp/native-cdp-probe.mjs',
  'port/tests/native-cdp/native-cdp-probe.test.mjs',
  'port/src-tauri/app/src/renderer_diagnostics.rs',
])

const failures = []
for (const file of tracked) {
  for (const rule of RULES) {
    if (rule.file && rule.file.test(file)) {
      failures.push(`${file}: ${rule.name} (${rule.hint})`)
    }
  }
  if (ALLOWLIST.has(file)) continue
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    continue
  }
  if (text.includes('\0')) continue // binary
  for (const rule of RULES) {
    if (rule.text && rule.text.test(text)) {
      failures.push(`${file}: ${rule.name} (${rule.hint})`)
    }
  }
}

if (failures.length > 0) {
  console.error('repository hygiene gate failed:')
  for (const failure of failures) console.error(`  ${failure}`)
  process.exit(1)
}
console.log(`repository hygiene gate: ${tracked.length} tracked files clean`)
