/**
 * Containment for the opt-in Host integration fixture.
 *
 * WHY THIS EXISTS: the fixture spawns a real Host process. It used to hand that
 * process `process.env` with three keys overridden, which means every ambient
 * variable of whoever ran the test was inherited: any `DSH_*` (including a real
 * production `DSH_HOME` or control endpoint), any `WEBVIEW2_*` browser profile
 * pointer, and any API key, token, credential, proxy or runtime/interpreter
 * override present in the operator's shell. A fixture that reports "isolated"
 * while inheriting the live product's control socket and credentials is exactly
 * the false green this repository keeps finding elsewhere: the report is a
 * claim, and the claim was not true of the process that produced it.
 *
 * This module builds the child's environment from an explicit deny
 * classification and then re-asserts the result, so the report's isolation claim
 * is checked against the environment actually spawned rather than against the
 * intent that produced it. It also hardens the fresh fixture directory to
 * current-user + SYSTEM only.
 *
 * NOTHING INHERITED IS TRUSTED. Deny rules are pattern-based on the NAME, never
 * on the value, and no denied name's value is ever read into a report, a log or
 * a thrown message — the report records the name and the reason category only.
 *
 * This module performs no I/O beyond the ACL calls it makes on a directory the
 * caller owns; it does not spawn the Host, and it never binds a port.
 */

import { spawnSync } from 'node:child_process'
import { posix, win32, isAbsolute } from 'node:path'

// ---------------------------------------------------------------------------
// Deny classification
// ---------------------------------------------------------------------------

/**
 * Name patterns removed from the inherited environment, with the reason
 * category recorded for each. Order matters only for readability; a name can
 * match more than one and the first matching category is reported.
 */
export const ENV_DENY_RULES = [
  { id: 'dsh-product-state', test: name => /^DSH_/iu.test(name) },
  { id: 'webview2-profile', test: name => /^WEBVIEW2_/iu.test(name) },
  {
    id: 'proxy-override',
    test: name => /(^|_)(PROXY|PROXIES)(_|$)/iu.test(name) || /^(NO_PROXY|NO_PROXY_)$/iu.test(name),
  },
  {
    id: 'secret-bearer',
    test: name => /(^|_)(API_?KEY|ACCESS_?KEY|SECRET|SECRET_?KEY|PASSWORD|PASSWD|PASSPHRASE|CREDENTIALS?|PRIVATE_?KEY|SESSION_?KEY|SIGNING_?KEY|LICENSE_?KEY|BEARER|AUTH_?TOKEN|OAUTH)(_|$)/iu.test(name),
  },
  {
    id: 'token-bearer',
    test: name => /(^|_)(TOKEN|SESSION_ID|SESSIONID|COOKIE|AUTH)(_|$)/iu.test(name),
  },
  {
    id: 'runtime-override',
    test: name => /^(NODE_OPTIONS|NODE_PATH|NODE_REPL_EXTERNAL_MODULE|NODE_EXTRA_CA_CERTS|ELECTRON_RUN_AS_NODE|DSH_DESKTOP_RUNTIME_DIR|DSH_DESKTOP_NODE[A-Z_]*|UV_THREADPOOL_SIZE)$/iu.test(name),
  },
  // Windows environment NAMES are case-insensitive, so `Npm_`, `NpM_` and
  // `nPm_` are the same variable as `NPM_`. A case-sensitive pattern would let a
  // mixed-case name carry a registry or interpreter override straight through.
  { id: 'package-manager-override', test: name => /^(npm|pnpm|yarn|corepack)_/iu.test(name) },
  {
    id: 'network-trust-override',
    test: name => /^(SSL_CERT_FILE|SSL_CERT_DIR|NODE_TLS_REJECT_UNAUTHORIZED|CURL_CA_BUNDLE|REQUESTS_CA_BUNDLE|GIT_SSL_CAINFO|EXTRA_CA_CERTS)$/iu.test(name),
  },
  {
    id: 'process-launch-override',
    test: name => /^(ELECTRON_ENABLE_LOGGING|ELECTRON_ENABLE_STACK_DUMPING|POWERSHELL_TELEMETRY_OPTOUT|AZURE_|IDENTITY_|MSI_)/iu.test(name),
  },
]

/**
 * Classify one environment variable NAME. Values are never inspected.
 *
 * @param {string} name Variable name.
 * @returns {string|null} The deny category, or null when the name is not denied.
 */
export function classifyFixtureEnvName(name) {
  for (const rule of ENV_DENY_RULES) if (rule.test(name)) return rule.id
  return null
}

/** Variable names whose value must be a path inside the fixture root. */
export const CONTAINED_PATH_KEYS = Object.freeze([
  'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'DSH_HOME',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME',
])

/** The control variables the fixture owns and asserts on. */
export const CONTROL_KEYS = Object.freeze(['DSH_DESKTOP_CONTROL_SOCKET', 'DSH_DESKTOP_CONTROL_TOKEN'])

// ---------------------------------------------------------------------------
// Path containment
// ---------------------------------------------------------------------------

/**
 * Windows `HOMEDRIVE` / `HOMEPATH` split, or null off Windows.
 * @param {string} home An absolute directory.
 * @returns {{drive: string, path: string}|null}
 */
export function splitHomeDrive(home, platform = process.platform) {
  if (platform !== 'win32') return null
  const match = /^([A-Za-z]:)(.*)$/u.exec(home)
  return match ? { drive: match[1], path: match[2].startsWith('\\') ? match[2] : `\\${match[2]}` } : null
}

/**
 * Whether `candidate` is `root` itself or a descendant of it, on a directory
 * boundary. `.scratch-escape` is NOT inside `.scratch`.
 *
 * @param {string} candidate Path under test.
 * @param {string} root The owned root.
 * @param {string} [platform]
 * @returns {boolean}
 */
export function isInsideRoot(candidate, root, platform = process.platform) {
  if (typeof candidate !== 'string' || candidate === '' || typeof root !== 'string' || root === '') return false
  const api = /^[A-Za-z]:[\\/]/u.test(root) ? win32 : posix
  const fold = value => (api === win32 ? value.toLowerCase() : value).replace(/[\\/]+$/u, '')
  const target = fold(api.resolve(candidate))
  const base = fold(api.resolve(root))
  return target === base || target.startsWith(`${base}${api.sep}`)
}

// ---------------------------------------------------------------------------
// Environment construction
// ---------------------------------------------------------------------------

/**
 * Build the environment a spawned Host is allowed to see.
 *
 * Inherited names that match a deny rule are dropped. Everything else is passed
 * through unchanged, because the Host is a real product process and stripping
 * e.g. `SystemRoot` or `PATH` would change what is being tested. Fixture-owned
 * paths are then written over the inherited ones, so no operator home, temp
 * directory or application-data root can reach the child.
 *
 * @param {object} options
 * @param {NodeJS.ProcessEnv} options.inherited The parent environment to filter.
 * @param {string} options.root The fixture root; owns every path the child sees.
 * @param {string} options.home The fixture `HOME`/`DSH_HOME`.
 * @param {{socket: string, token: string}|null} options.control Owned control channel, or null.
 * @param {string} [options.platform]
 * @returns {{env: Record<string,string>, owned: Record<string,string>, ownedKeys: string[],
 *   stripped: Array<{name: string, reason: string}>, categories: Record<string, number>}}
 */
export function buildFixtureEnvironment({ inherited = {}, root, home, control = null, platform = process.platform }) {
  const stripped = []
  const categories = {}
  const env = {}
  for (const [name, value] of Object.entries(inherited)) {
    if (value === undefined) continue
    const reason = classifyFixtureEnvName(name)
    if (reason !== null) {
      stripped.push({ name, reason })
      categories[reason] = (categories[reason] ?? 0) + 1
      continue
    }
    env[name] = value
  }
  const appData = `${root}/appdata`
  const split = splitHomeDrive(home, platform)
  const owned = {
    HOME: home,
    USERPROFILE: home,
    APPDATA: `${appData}/Roaming`,
    LOCALAPPDATA: `${appData}/Local`,
    TEMP: root,
    TMP: root,
    DSH_HOME: home,
    // The platform config/data roots are fixture-owned too: an operator's real
    // config directory must never be readable or writable by the spawned Host.
    XDG_CONFIG_HOME: `${appData}/config`,
    XDG_DATA_HOME: `${appData}/data`,
    XDG_CACHE_HOME: `${appData}/cache`,
    XDG_STATE_HOME: `${appData}/state`,
  }
  if (split) {
    owned.HOMEDRIVE = split.drive
    owned.HOMEPATH = split.path
  }
  if (control) {
    owned.DSH_DESKTOP_CONTROL_SOCKET = control.socket
    owned.DSH_DESKTOP_CONTROL_TOKEN = control.token
  }
  for (const [name, value] of Object.entries(owned)) {
    if (value === undefined || value === null || value === '') continue
    env[name] = value
  }
  if (!control) for (const name of CONTROL_KEYS) delete env[name]
  const ownedKeys = Object.keys(env).filter(name => owned[name] !== undefined)
  return { env, owned, ownedKeys, stripped, categories }
}

// ---------------------------------------------------------------------------
// Assertion: the report's isolation claim, checked against the real environment
// ---------------------------------------------------------------------------

/**
 * Re-check the environment that will actually be spawned. This is deliberately
 * independent of `buildFixtureEnvironment`: it reads only the finished object,
 * so a future edit that forgets to strip something, or overwrites an owned value
 * with an inherited one, fails here instead of producing a quiet report.
 *
 * @param {Record<string,string>} env The environment about to be spawned.
 * @param {object} options
 * @param {string} options.root The fixture root.
 * @param {boolean} options.controlled Whether an owned control channel is expected.
 * @param {string[]} [options.ownedKeys] Names deliberately set by the fixture.
 * @param {Record<string,string>} [options.inherited] The unfiltered parent environment.
 * @returns {string[]} Violations; empty means the environment is contained.
 */
export function assertFixtureEnvironment(env, { root, controlled, ownedKeys = [], inherited = {} }) {
  const violations = []
  const allow = new Set(ownedKeys)
  for (const name of Object.keys(env)) {
    const category = classifyFixtureEnvName(name)
    if (category !== null && !allow.has(name)) {
      violations.push(`env ${name} survived stripping (${category}) but was never added back by the fixture`)
    }
  }
  for (const name of Object.keys(inherited)) {
    if (!(name in env)) continue
    if (classifyFixtureEnvName(name) !== null && !allow.has(name)) {
      violations.push(`inherited ${name} reached the child unchanged`)
    }
  }
  for (const name of CONTAINED_PATH_KEYS) {
    if (!(name in env)) {
      violations.push(`env ${name} is absent; the child would fall back to a real operator directory`)
      continue
    }
    const value = env[name]
    if (!isAbsolute(value)) {
      violations.push(`env ${name} is not absolute: it would resolve against the child's own working directory`)
      continue
    }
    if (!isInsideRoot(value, root)) {
      violations.push(`env ${name} points outside the fixture root`)
    }
  }
  for (const name of CONTROL_KEYS) {
    const present = typeof env[name] === 'string' && env[name] !== ''
    if (controlled && !present) violations.push(`controlled launch is missing owned ${name}`)
    if (!controlled && present) violations.push(`uncontrolled launch must not carry ${name}`)
  }
  return violations
}

/**
 * A short, value-free description of what the environment guarantee actually
 * was, for the fixture report.
 *
 * @param {{stripped: Array<{name: string, reason: string}>, categories: Record<string, number>, ownedKeys: string[], violations: string[]}} built
 * @returns {object}
 */
export function describeEnvironmentGuarantee(built) {
  return {
    inheritedNamesStripped: built.stripped.length,
    strippedCategories: Object.fromEntries(Object.entries(built.categories).sort(([a], [b]) => a.localeCompare(b))),
    strippedNames: built.stripped.map(entry => entry.name).sort(),
    ownedNames: [...built.ownedKeys].sort(),
    containmentViolations: built.violations,
    policy: 'deny-by-name from the parent environment, then fixture-owned paths written over; no denied value is recorded',
  }
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/**
 * Build a redactor for values that must never reach a report, a log or stdout.
 *
 * The set is LIVE, not a snapshot. A fixture learns most of its secrets only
 * while it runs — the control token and socket name exist before the run, but
 * the URL the Host advertises, the token inside it and the session cookies are
 * produced by the run itself. A redactor frozen at construction would miss
 * exactly those, so `add()` extends it and `redact()` reads the current set.
 *
 * Values shorter than 8 characters are not treated as redactable: erasing a
 * short string would destroy unrelated text without protecting anything. The
 * caller must not assume a short secret was therefore safe.
 *
 * @param {Array<string|undefined|null>} [secrets] Values to erase.
 * @returns {{redact: (text: string) => string, add: (...values: Array<string|undefined|null>) => number,
 *   secrets: () => string[], has: (value: string) => boolean}}
 */
export function createRedactor(secrets = []) {
  const usable = new Set()
  const usableValue = value => typeof value === 'string' && value.length >= 8
  const add = (...values) => {
    let added = 0
    for (const value of values) {
      if (!usableValue(value) || usable.has(value)) continue
      usable.add(value)
      added += 1
    }
    return added
  }
  add(...secrets)
  const redact = text => {
    let output = typeof text === 'string' ? text : String(text ?? '')
    for (const secret of usable) output = output.split(secret).join('<redacted>')
    return output
  }
  return { redact, add, secrets: () => [...usable], has: value => usable.has(value) }
}

/**
 * Refuse to write an artifact that contains a secret. Reporting a leak is
 * cheaper than publishing one.
 *
 * @param {string} text Artifact content.
 * @param {string[]} secrets
 * @param {string} label What is being written.
 * @returns {void}
 * @throws {Error} When a secret is present.
 */
export function assertNoSecrets(text, secrets, label) {
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 8 && text.includes(secret)) {
      throw new Error(`${label} contains a fixture secret; refusing to write it`)
    }
  }
}

// ---------------------------------------------------------------------------
// Fresh-directory ACL containment (Windows only)
// ---------------------------------------------------------------------------

/**
 * The default process runner used for the ACL calls. `icacls` is a native
 * Windows binary invoked without a shell, so a fixture path is never
 * interpolated into a command line.
 *
 * @param {string} file
 * @param {string[]} args
 * @returns {{status: number|null, stdout: string, stderr: string, error?: Error}}
 */
export function defaultAclRunner(file, args) {
  const result = spawnSync(file, args, { encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 })
  if (result.error) return { status: null, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? ''), error: result.error }
  return { status: result.status, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') }
}

/**
 * Apply current-user + SYSTEM full control to a directory the caller just
 * created, with inheritance from the repository removed.
 *
 * The command is `icacls` on purpose: it is a native Windows binary, needs no
 * script-execution policy and no .NET access-control objects. It is applied ONLY
 * to the fixture directory the caller owns; no repository, install or user
 * directory is ever named.
 *
 * @param {string} directory Absolute path of a freshly created fixture directory.
 * @param {{run: (file: string, args: string[]) => {status: number|null, stdout: string, stderr: string, error?: Error}}} run Injected process runner.
 * @returns {{applied: boolean, commands: Array<{args: string[], status: number|null, stdout: string, stderr: string}>, error?: string}}
 */
export function hardenFixtureDirectory(directory, { run }) {
  if (process.platform !== 'win32') return { applied: false, commands: [], error: 'not applicable off Windows' }
  const args = [
    directory,
    '/inheritance:r',
    '/grant:r',
    `${accountName(run)}:(OI)(CI)F`,
    '*S-1-5-18:(OI)(CI)F',
  ]
  const result = run('icacls', args)
  const record = { args, status: result.status, stdout: result.stdout, stderr: result.stderr }
  if (result.status !== 0 || result.error) {
    return { applied: false, commands: [record], error: result.error ? String(result.error.message ?? result.error) : `icacls exited ${result.status}` }
  }
  return { applied: true, commands: [record] }
}

/**
 * Resolve the current account name in the form `icacls` accepts, using the
 * injected runner so this stays testable.
 *
 * @param {{run: Function}} run
 * @returns {string}
 */
function accountName(run) {
  const probe = run('cmd', ['/d', '/c', 'echo', '%USERNAME%'])
  const name = String(probe.stdout ?? '').trim()
  return name === '' ? 'SYSTEM' : name
}

/**
 * Read back the directory's access rules and report every principal named.
 *
 * `icacls` listing is not parsed: its alignment makes a principal ambiguous with
 * the path that precedes it on the first line. `Get-Acl` reports the same
 * rules as discrete records, so there is nothing to mis-split. This is a
 * read-only query against a directory the caller owns.
 *
 * @param {string} directory
 * @param {{run: Function}} run
 * @returns {{principals: string[], inherited: string[], raw: string, error?: string}}
 */
export function readFixtureDirectoryAcls(directory, { run }) {
  if (process.platform !== 'win32') return { principals: [], inherited: [], raw: '', error: 'not applicable off Windows' }
  const literal = String(directory).replace(/'/gu, "''")
  const script = [
    `$ErrorActionPreference='Stop'`,
    `try {`,
    `$acl = Get-Acl -LiteralPath '${literal}' -ErrorAction Stop`,
    `if ($null -eq $acl) { [Console]::Error.WriteLine('no ACL'); exit 3 }`,
    `$acl.Access | ForEach-Object { "$($_.IdentityReference.Value)|$($_.AccessControlType)|$($_.IsInherited)" }`,
    `} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 4 }`,
  ].join('\n')
  const result = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])
  if (result.status !== 0 || result.error) {
    return { principals: [], inherited: [], raw: String(result.stdout ?? ''), error: result.error ? String(result.error.message ?? result.error) : `Get-Acl exited ${result.status}` }
  }
  const raw = String(result.stdout ?? '')
  const principals = []
  const inherited = []
  // Each record is `name|accessControlType|isInherited`; the name is the first
  // field so a principal containing a space cannot be mis-split.
  for (const line of raw.split(/\r?\n/u)) {
    const parts = line.split('|')
    if (parts.length < 3) continue
    const name = parts[0]
    if (name.trim() === '') continue
    principals.push(name.trim())
    if (parts[2].trim().toLowerCase() === 'true') inherited.push(name.trim())
  }
  return { principals, inherited, raw }
}

/**
 * Whether a principal is the account the fixture runs as.
 *
 * Windows resolves an unqualified account to its domain form (`CONTOSO\user`),
 * so the comparison is on the final segment rather than on the whole string.
 *
 * @param {string} principal
 * @param {string} account
 * @returns {boolean}
 */
function isSameAccount(principal, account) {
  const fold = value => String(value ?? '').toLowerCase().replace(/\\+$/u, '')
  const named = fold(principal)
  const user = fold(account)
  if (named === '' || user === '') return false
  return named === user || named.endsWith(`\\${user}`)
}

/**
 * Assert a hardened fixture directory names only the current user and SYSTEM,
 * and carries no inherited rule at all.
 *
 * @param {string} directory
 * @param {{run: Function, account?: string}} options
 * @returns {{contained: boolean, principals: string[], unexpected: string[], errors: string[]}}
 */
export function assertFixtureDirectoryAcls(directory, { run, account }) {
  const applicable = process.platform === 'win32'
  if (!applicable) return { applicable: false, contained: false, principals: [], inherited: [], unexpected: [], errors: [] }
  const applied = hardenFixtureDirectory(directory, { run })
  const audit = readFixtureDirectoryAcls(directory, { run })
  const errors = []
  if (!applied.applied) errors.push(`ACL hardening failed: ${applied.error ?? 'unknown icacls failure'}`)
  if (audit.error) errors.push(`ACL audit failed: ${audit.error}`)
  const isSystem = principal => ['system', 'nt authority\\system'].includes(String(principal).toLowerCase())
  const unexpected = audit.principals.filter(principal => !isSameAccount(principal, account) && !isSystem(principal))
  if (unexpected.length > 0) errors.push(`fixture directory names unexpected principals: ${unexpected.join(', ')}`)
  if (audit.inherited.length > 0) {
    errors.push(`fixture directory still inherits access from ${audit.inherited.join(', ')}; /inheritance:r did not take effect`)
  }
  if (audit.principals.length === 0 && !audit.error) errors.push('ACL audit returned no access rules; containment is unproven')
  return { applicable: true, contained: errors.length === 0, principals: audit.principals, inherited: audit.inherited, unexpected, errors }
}