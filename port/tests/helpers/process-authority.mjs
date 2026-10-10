/**
 * Termination authority for the opt-in Host integration fixture.
 *
 * WHY THIS EXISTS: on timeout the fixture called `child.kill()` on the basis of
 * a `ChildProcess` object and the fact that no `exit` event had been observed.
 * Neither fact proves the PID still belongs to the process this fixture spawned.
 * Termination is by PID, and a PID that has been released — because the child
 * died, or because the fixture lost track of it — can be reused by an unrelated
 * process. A force-kill path that trusts an object reference is therefore a
 * blanket-kill path wearing a targeted one's name, and the only moment its
 * safety matters is exactly the moment nobody is watching.
 *
 * So authority is established from the OPERATING SYSTEM's current view of the
 * process, immediately before terminating: same PID, same executable, and the
 * same process creation time as observed at spawn. A PID whose creation time has
 * moved is a different process even though the number matches. If that identity
 * cannot be resolved — no rights to query it, the tool missing, the query failing
 * — the fixture does NOT terminate anything. It unrefs the handle, records the
 * unresolved root in the report, and lets the run fail on that fact. An
 * unidentified process is never killed on a guess, and it is never silently
 * forgotten either.
 *
 * This module never kills a process it did not itself spawn, and it never walks
 * a tree to kill: the only termination it performs is against the single child
 * the fixture itself launched and proved it still owns. What the Host itself
 * spawned — backend, gateway, any node — is *accounted for*, by reading the
 * process table and attributing survivors by parent id and creation time. Those
 * survivors are reported, never killed: a descendant carries no spawn-time
 * observation of its own, so the identity argument that authorises terminating
 * the direct child does not extend to it, and a wrong kill is worse than a
 * recorded leftover. When attribution cannot be completed the result is
 * `not verified`, which the fixture treats as a failure rather than a pass.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** How long to wait for the identity query and for a termination to take effect. */
export const IDENTITY_TIMEOUT_MS = 15_000
export const TERMINATION_TIMEOUT_MS = 10_000

/**
 * Build the PowerShell query that reports the OS's current view of a PID.
 *
 * It returns `pid|exe|creationTicks`, using the process start time in UTC ticks
 * so two different processes can never compare equal by truncation.
 *
 * @param {number} pid
 * @returns {string} A PowerShell expression, with the PID embedded as a literal.
 */
/**
 * Build the read-only CIM query for ONE process.
 *
 * It emits `pid|exe|creationTicks`, or nothing at all when the OS reports no
 * process with that id.
 *
 * WHY CIM AND NOT `Get-Process`: `Get-Process -Id N` on a pid it cannot read —
 * denied, or protected — writes to stderr and leaves stdout EMPTY, which is byte
 * for byte what "no such process" produces. Under a tri-state contract that is
 * the worst possible collision: a permission denial silently becomes an ABSENT
 * verdict, and a query failure becomes a clean teardown. `Get-CimInstance` with a
 * filtered query and `-ErrorAction Stop` separates them properly: a fault exits
 * non-zero with the message on stderr, while zero matching rows is a normal,
 * successful, EMPTY result. Only the empty-and-successful case is absence.
 *
 * @param {number} pid
 * @returns {string} A PowerShell expression; `""` when the pid is not usable.
 */
export function buildIdentityQuery(pid) {
  const literal = Number.isInteger(pid) && pid > 0 ? String(pid) : null
  if (literal === null) return '""'
  return [
    `$ErrorActionPreference='Stop'`,
    `try {`,
    `$rows = @(Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = ${literal}" -ErrorAction Stop)`,
    `if ($rows.Length -eq 0) { '${ABSENT_SENTINEL}' } else { "$($rows[0].ProcessId)|$($rows[0].ExecutablePath)|$($rows[0].CreationDate.ToUniversalTime().Ticks)" }`,
    `} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 4 }`,
  ].join('\n')
}

/**
 * The token the identity query emits when the OS positively reports no such
 * process.
 *
 * Absence must be STATED, never inferred from emptiness. An empty stdout is a
 * failed read — a swallowed error, a broken pipe, a shell that never ran — and
 * under a tri-state contract treating it as absence is how a permission denial
 * becomes a clean teardown. Only this exact token, emitted by a query that
 * exited successfully, is absence.
 */
export const ABSENT_SENTINEL = 'PROCESS-NOT-FOUND'

/**
 * The three states a PID query can end in. They are NOT interchangeable.
 *
 * - `present`  — the operating system named a process and this fixture read it.
 * - `absent`   — the operating system was asked and reported no such process.
 * - `unknown`  — the question could not be answered (denied, unavailable,
 *                unparseable, or the pid was never a pid at all).
 *
 * `unknown` is the one that gets conflated, and the conflation is the bug this
 * split exists to prevent: "I could not look" and "there is nothing there" have
 * opposite consequences, and collapsing them lets a query failure read as a
 * clean teardown. Only `absent` may ever be treated as absence.
 */
export const IDENTITY_STATUS = Object.freeze({ PRESENT: 'present', ABSENT: 'absent', UNKNOWN: 'unknown' })

/** The single reason that means "the OS says there is no such process". */
export const ABSENCE_REASON = 'no process with that pid exists'

/**
 * Whether an identity positively establishes that the process does not exist.
 *
 * This is the ONLY predicate that may be used to conclude absence. It is
 * deliberately narrow: `available === false` alone is not absence, because a
 * failed query also reports `available === false`.
 *
 * @param {{status?: string, reason?: string}|null|undefined} identity
 * @returns {boolean}
 */
export function processIsAbsent(identity) {
  if (!identity || typeof identity !== 'object') return false
  if (identity.status === IDENTITY_STATUS.ABSENT) return true
  // Tolerate an identity produced without a `status`, but ONLY when it carries
  // the exact absence reason. An empty-string or blank identity is never absence.
  return identity.status === undefined && identity.reason === ABSENCE_REASON
}

/** Normalise an identity to carry an explicit status, defaulting to unknown. */
function withStatus(identity) {
  const status = identity.status ?? (processIsAbsent(identity) ? IDENTITY_STATUS.ABSENT : IDENTITY_STATUS.UNKNOWN)
  return { ...identity, status }
}

/**
 * Parse the identity query output.
 *
 * ABSENCE MUST BE STATED. Only the query's own sentinel, on a query that
 * completed, means the OS reports no such process. EMPTY OUTPUT MEANS UNKNOWN —
 * a swallowed error, a shell that never ran, a truncated pipe all produce it,
 * and reading it as absence would turn a permission denial into a clean
 * teardown. A present process whose metadata is DENIED or whose start time is
 * unreadable is likewise `unknown` about its identity, not `absent`.
 *
 * @param {string} stdout
 * @returns {{available: boolean, status: string, pid: number|null, exe: string|null, creationTicks: string|null, reason: string}}
 */
export function parseProcessIdentity(stdout) {
  const raw = String(stdout ?? '').trim()
  if (raw === ABSENT_SENTINEL) {
    return { available: false, status: IDENTITY_STATUS.ABSENT, pid: null, exe: null, creationTicks: null, reason: ABSENCE_REASON }
  }
  if (raw === '') {
    return { available: false, status: IDENTITY_STATUS.UNKNOWN, pid: null, exe: null, creationTicks: null, reason: 'the identity query produced no output at all, which is a failed read, not an absence' }
  }
  const line = raw.split(/\r?\n/u).find(entry => entry.includes('|')) ?? ''
  const parts = line.split('|')
  if (parts.length < 3) {
    return { available: false, status: IDENTITY_STATUS.UNKNOWN, pid: null, exe: null, creationTicks: null, reason: 'identity output was not pid|exe|creation' }
  }
  const [pidText, exe, creationTicks] = parts
  const pid = Number(pidText.trim())
  if (!Number.isInteger(pid) || pid <= 0 || !/^\d+$/u.test(creationTicks.trim())) {
    return { available: false, status: IDENTITY_STATUS.UNKNOWN, pid: null, exe: null, creationTicks: null, reason: 'identity output was not parseable' }
  }
  return { available: true, status: IDENTITY_STATUS.PRESENT, pid, exe: exe.trim() || null, creationTicks: creationTicks.trim(), reason: '' }
}

/**
 * Query the OS for a PID's current identity.
 *
 * @param {number} pid
 * @param {{run?: (query: string) => Promise<string>, timeoutMs?: number}} [options]
 * @returns {Promise<{available: boolean, status: string, pid: number|null, exe: string|null, creationTicks: string|null, reason: string}>}
 */
export async function captureProcessIdentity(pid, { run, timeoutMs = IDENTITY_TIMEOUT_MS } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return { available: false, status: IDENTITY_STATUS.UNKNOWN, pid: null, exe: null, creationTicks: null, reason: `pid ${String(pid)} is not a process identifier` }
  }
  const query = run ?? (async (script) => execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
  ))
  try {
    const raw = await query(buildIdentityQuery(pid))
    if (raw !== null && typeof raw === 'object' && 'available' in raw) return withStatus(raw)
    const stdout = typeof raw === 'string' ? raw : String(raw?.stdout ?? '')
    const status = typeof raw === 'string' ? 0 : (raw?.status ?? 0)
    if (status !== 0 && status !== null) {
      const detail = typeof raw === 'string' ? '' : String(raw?.stderr ?? '').trim()
      return { available: false, status: IDENTITY_STATUS.UNKNOWN, pid: null, exe: null, creationTicks: null, reason: `identity query exited ${status}${detail === '' ? '' : `: ${detail}`}` }
    }
    return parseProcessIdentity(stdout)
  } catch (error) {
    // A failed query is NOT evidence the process is gone. It is the absence of
    // authority, and the caller must treat it that way.
    return { available: false, status: IDENTITY_STATUS.UNKNOWN, pid: null, exe: null, creationTicks: null, reason: `identity query failed: ${error?.code ?? error?.message ?? String(error)}` }
  }
}

/**
 * Decide whether a freshly observed identity is still the process this fixture
 * spawned. Same PID alone is never enough.
 *
 * @param {{available: boolean, pid: number|null, exe: string|null, creationTicks: string|null}|null} observedAtSpawn
 * @param {{available: boolean, pid: number|null, exe: string|null, creationTicks: string|null}} fresh
 * @param {{expectedExe?: string}} [options]
 * @returns {{owned: boolean, reason: string}}
 */
export function compareProcessIdentity(observedAtSpawn, fresh, { expectedExe } = {}) {
  // An identity handed in by an older caller carries no `status`; normalise it
  // rather than rejecting it, so the status defaults to UNKNOWN rather than
  // being read as absent.
  const current = fresh === null || fresh === undefined ? null : withStatus(fresh)
  const spawn = observedAtSpawn === null || observedAtSpawn === undefined ? null : withStatus(observedAtSpawn)
  const refuse = (reason, absent = false) => ({ owned: false, absent, reason })
  if (!spawn || !spawn.available) {
    return refuse(`spawn-time identity was never established (${spawn?.reason ?? 'not captured'}); a child handle alone does not prove which process holds the pid`)
  }
  // Absence and an unanswered question are reported differently on purpose. A
  // pid the OS says is gone is a real finding; a pid we could not read is not,
  // and neither one authorises a termination.
  if (processIsAbsent(current)) {
    return refuse(`pid ${spawn.pid} no longer exists`, true)
  }
  if (!current || current.status !== IDENTITY_STATUS.PRESENT || !current.available) {
    return refuse(`current identity is not established (${current?.reason ?? 'not resolved'}); refusing to terminate an unidentified process`)
  }
  if (current.pid !== spawn.pid) return refuse(`pid changed from ${spawn.pid} to ${current.pid}`)
  if (current.creationTicks !== spawn.creationTicks) {
    return refuse(`pid ${current.pid} now refers to a process created at ${current.creationTicks}, not ${spawn.creationTicks}; the original has exited and its pid was reused`)
  }
  const fold = value => (value === null || value === undefined ? null : String(value).toLowerCase())
  // Two unknown executables are not evidence of a match. Without a name the
  // comparison would pass on the sole ground that both sides are empty, which is
  // precisely the "no evidence either way" case that must never authorise a kill.
  if (fold(current.exe) === null) {
    return refuse(`pid ${current.pid} has no readable executable name; an unidentifiable process is not an owned one`)
  }
  if (fold(spawn.exe) === null) {
    return refuse(`the spawn-time identity for pid ${spawn.pid} carried no executable name; there is nothing to compare against`)
  }
  if (fold(current.exe) !== fold(spawn.exe)) {
    return refuse(`pid ${current.pid} now runs ${current.exe ?? '<unknown>'}, not ${spawn.exe ?? '<unknown>'}`)
  }
  if (expectedExe && fold(current.exe) !== fold(expectedExe)) {
    return refuse(`pid ${current.pid} runs ${current.exe ?? '<unknown>'}, not the interpreter this fixture launched (${expectedExe})`)
  }
  return { owned: true, absent: false, reason: '' }
}

/**
 * Terminate an owned child, or record why it was not terminated.
 *
 * @param {object} options
 * @param {import('node:child_process').ChildProcess} options.child The child this fixture spawned.
 * @param {object|null} options.identityAtSpawn Identity captured immediately after spawn.
 * @param {string|null} [options.label] Name used in the report.
 * @param {string|null} [options.expectedExe] The interpreter path the fixture launched.
 * @param {(pid: number) => Promise<object>} [options.capture] Injected identity source.
 * @param {number} [options.terminationTimeoutMs]
 * @returns {Promise<{terminated: boolean, alreadyExited: boolean, alreadyAbsent: boolean,
 *   identity: object, unresolvedRoots: Array<object>, note: string}>} Never throws; the report
 *   carries the outcome. `alreadyAbsent` is set ONLY when the OS positively reported
 *   the process gone; an unanswered query leaves it false and raises an unresolved root.
 */
export async function terminateOwnedChild({ child, identityAtSpawn, label = 'host', expectedExe = null, capture, terminationTimeoutMs = TERMINATION_TIMEOUT_MS }) {
  const unresolved = entry => ({
    label,
    pid: entry.pid ?? null,
    reason: entry.reason,
    action: 'not terminated; the handle was unref\'d and the run is failed on this fact',
  })
  if (child.exitCode !== null || child.signalCode !== null) {
    return { terminated: false, alreadyExited: true, alreadyAbsent: false, identity: null, unresolvedRoots: [], note: 'the owned child had already exited' }
  }
  const identity = await captureProcessIdentity(child.pid, { run: capture })
  const verdict = compareProcessIdentity(identityAtSpawn, identity, { expectedExe })
  if (!verdict.owned) {
    child.unref()
    // A positive "no such process" is a finding, not a failure: there is nothing
    // left to terminate and nothing to clean up. Everything else — an
    // unreadable pid, a reused pid, a different image — stays an unresolved root.
    // In particular an unanswered query NEVER reaches this branch.
    if (verdict.absent === true) {
      return {
        terminated: false,
        alreadyExited: false,
        alreadyAbsent: true,
        identity,
        unresolvedRoots: [],
        note: verdict.reason,
      }
    }
    return {
      terminated: false,
      alreadyExited: false,
      alreadyAbsent: false,
      identity,
      unresolvedRoots: [unresolved({ pid: child.pid, reason: verdict.reason })],
      note: verdict.reason,
    }
  }
  child.kill()
  const exited = await new Promise((done) => {
    const timer = setTimeout(() => done(false), terminationTimeoutMs)
    child.once('exit', () => { clearTimeout(timer); done(true) })
    if (typeof child.unref === 'function' && child.exitCode === null) child.unref()
  })
  if (exited) return { terminated: true, alreadyExited: false, alreadyAbsent: false, identity, unresolvedRoots: [], note: `terminated owned pid ${child.pid} after identity verification` }
  child.unref()
  return {
    terminated: false,
    alreadyExited: false,
    alreadyAbsent: false,
    identity,
    unresolvedRoots: [unresolved({ pid: child.pid, reason: 'the verified process did not report an exit within the timeout; nothing further was attempted' })],
    note: 'termination was requested after identity verification but no exit was observed',
  }
}

/**
 * Summarise termination attempts for the fixture report, without PID churn
 * masquerading as a result.
 *
 * @param {Array<object>} outcomes Results of `terminateOwnedChild`.
 * @returns {{policy: string, attempted: number, terminated: number, alreadyAbsent: number, unresolvedRoots: Array<object>}}
 */
export function summariseTermination(outcomes) {
  return {
    policy: 'terminate only after a fresh OS identity check (pid, exe and creation time) matches the spawn-time observation; otherwise unref and report. Only a positive "no such process" counts as absent — an unanswered query never does',
    attempted: outcomes.length,
    terminated: outcomes.filter(outcome => outcome.terminated).length,
    alreadyAbsent: outcomes.filter(outcome => outcome.alreadyAbsent === true).length,
    unresolvedRoots: outcomes.flatMap(outcome => outcome.unresolvedRoots),
  }
}

// ---------------------------------------------------------------------------
// Descendant accounting — read-only, bounded, and never a kill
// ---------------------------------------------------------------------------

/** Maximum parent-chain depth walked when attributing a process to a Host. */
export const MAX_DESCENDANT_DEPTH = 12

/** Upper bound on processes carried in one snapshot, so a pathological table cannot grow without limit. */
export const MAX_TABLE_ROWS = 20_000

/**
 * Milliseconds-since-epoch to .NET UTC ticks (100 ns units since 0001-01-01).
 *
 * Windows reports process creation times in .NET ticks, so comparing a wall
 * clock against a creation time needs this conversion. Getting it wrong by the
 * epoch offset would silently attribute every process on the machine to the
 * fixture, which is why it is asserted directly.
 *
 * @param {number} milliseconds
 * @returns {bigint}
 */
export function epochMillisToTicks(milliseconds) {
  return (BigInt(Math.trunc(milliseconds)) + 62_135_596_800_000n) * 10_000n
}

/**
 * The current time as .NET UTC ticks, for bounding how recent a survivor is.
 *
 * @param {number} [now]
 * @returns {bigint}
 */
export function nowUtcTicks(now = Date.now()) {
  return epochMillisToTicks(now)
}

/**
 * Build the read-only CIM query for the whole process table.
 *
 * `Win32_Process` exposes `ParentProcessId` and `CreationDate`, which is what
 * makes attribution possible. This query READS the table. It starts, stops and
 * signals nothing.
 *
 * The error handling is deliberate and is the second half of a failure mode:
 * with `SilentlyContinue` a WMI/CIM fault produces EMPTY OUTPUT, which is
 * indistinguishable from "no processes exist" — an impossibility, since the
 * helper querying it is itself a process. So the preference is `Stop`, the read
 * is wrapped, and a fault exits non-zero with the message on stderr. Empty
 * output therefore means one thing only: the query ran and the system had no
 * processes, which is itself treated as `unknown` by the caller.
 *
 * @returns {string} A PowerShell expression emitting `pid|parentPid|name|exe|creationTicks`.
 */
export function buildProcessTableQuery() {
  return [
    `$ErrorActionPreference='Stop'`,
    `try {`,
    `Get-CimInstance -ClassName Win32_Process -ErrorAction Stop | ForEach-Object { "$($_.ProcessId)|$($_.ParentProcessId)|$($_.Name)|$($_.ExecutablePath)|$($_.CreationDate.ToUniversalTime().Ticks)" }`,
    `} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 4 }`,
  ].join('\n')
}

/**
 * Parse the snapshot into process rows.
 *
 * Nothing is dropped silently. A row whose exe is empty is KEPT — an unreadable
 * image path is a fact about the row. A row that cannot be parsed at all is
 * COUNTED in `rejected`, and a table cut short by the row bound is flagged in
 * `truncated`. Both make the snapshot `unknown`, because a partial view of the
 * process table cannot support a claim that nothing survived.
 *
 * @param {string} stdout
 * @returns {{rows: Array<{pid: number, parentPid: number, name: string, exe: string|null, creationTicks: bigint}>, rejected: number, truncated: boolean}}
 */
export function parseProcessTable(stdout) {
  const rows = []
  const seenPids = new Set()
  let rejected = 0
  let truncated = false
  for (const line of String(stdout ?? '').split(/\r?\n/u)) {
    if (line.trim() === '') continue
    if (rows.length >= MAX_TABLE_ROWS) { truncated = true; break }
    const parts = line.split('|')
    if (parts.length !== 5) { rejected += 1; continue }
    const [pidText, parentText, name, exe, ticksText] = parts
    const pid = Number(pidText.trim())
    const parentPid = Number(parentText.trim())
    if (!/^(0|[1-9]\d*)$/u.test(pidText.trim()) || !/^(0|[1-9]\d*)$/u.test(parentText.trim())
      || !Number.isSafeInteger(pid) || pid < 0 || pid > 0xFFFFFFFF
      || !Number.isSafeInteger(parentPid) || parentPid < 0 || parentPid > 0xFFFFFFFF
      || name.trim() === '' || !/^\d+$/u.test(ticksText.trim()) || seenPids.has(pid)) { rejected += 1; continue }
    let creationTicks
    try { creationTicks = BigInt(ticksText.trim()) } catch { rejected += 1; continue }
    seenPids.add(pid)
    rows.push({ pid, parentPid, name: name.trim(), exe: exe.trim() === '' ? null : exe.trim(), creationTicks })
  }
  return { rows, rejected, truncated }
}

/**
 * Read the live process table. Read-only: this never starts, stops or signals
 * anything, and it is the ONLY thing this module does to processes other than
 * terminating the single child the fixture itself spawned and proved it owns.
 *
 * `available` means "a complete, untruncated, fully parsed view of the table was
 * obtained". Anything else — a fault, an empty result, a rejected row, a
 * truncated table — is `available: false` with the reason, because the callers
 * use `available` as permission to make an absence claim and a partial view is
 * not permission.
 *
 * @param {{run?: (query: string) => Promise<{stdout?: string, status?: number|null}|string>, timeoutMs?: number}} [options]
 * @returns {Promise<{available: boolean, rows: Array<object>, rejected: number, truncated: boolean, observedAtTicks: bigint, reason: string}>}
 */
export async function captureProcessTable({ run, timeoutMs = 60_000 } = {}) {
  const observedAtTicks = nowUtcTicks()
  const unavailable = reason => ({ available: false, rows: [], rejected: 0, truncated: false, observedAtTicks, reason })
  if (process.platform !== 'win32') {
    return unavailable('descendant accounting is implemented against Win32_Process and is not available on this platform')
  }
  const query = run ?? (async (script) => execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
  ))
  try {
    const raw = await query(buildProcessTableQuery())
    // An injected source may return just stdout, or the whole exec result.
    const stdout = typeof raw === 'string' ? raw : String(raw?.stdout ?? '')
    const status = typeof raw === 'string' ? 0 : (raw?.status ?? 0)
    if (status !== 0 && status !== null) {
      const detail = typeof raw === 'string' ? '' : String(raw?.stderr ?? '').trim()
      return unavailable(`the process table query exited ${status}${detail === '' ? '' : `: ${detail}`}`)
    }
    const { rows, rejected, truncated } = parseProcessTable(stdout)
    if (rows.length === 0) {
      // The process running this query is, by construction, in the table.
      // An empty result is therefore a fault, never "nothing is alive".
      return unavailable('the process table query returned no rows; the query helper is itself a process, so an empty table is a failed read, not an absence')
    }
    if (rejected > 0) return unavailable(`${rejected} process row(s) could not be parsed; a partial table cannot support an absence claim`)
    if (truncated) return unavailable(`the process table exceeded ${MAX_TABLE_ROWS} rows and was cut short; a truncated table cannot support an absence claim`)
    return { available: true, rows, rejected, truncated, observedAtTicks, reason: '' }
  } catch (error) {
    return unavailable(`process table query failed: ${error?.code ?? error?.message ?? String(error)}`)
  }
}

/**
 * Walk the parent chain from a Host and return every process attributed to it.
 *
 * Attribution is by parent id AND by time: a row only belongs to this Host if it
 * was created at or after the Host itself and at or before the moment the table
 * was read. That is what stops a recycled pid from importing an unrelated
 * process into the record.
 *
 * THIS MUST BE CALLED ON A TABLE READ WHILE THE HOST WAS ALIVE. It is the
 * sampler, not the judge: after an intermediate process in the chain has exited,
 * its children still name it as parent but it has no row left to walk through,
 * so a tree deeper than one level becomes invisible. That is precisely why
 * `assessDescendants` compares a live sample against a later snapshot instead of
 * walking the final table.
 *
 * @param {object} options
 * @param {{pid: number, creationTicks: string|bigint}} options.host The Host this fixture spawned.
 * @param {Array<object>} options.table Rows from `captureProcessTable`.
 * @param {bigint} options.observedAtTicks When the table was read.
 * @param {number} [options.maxDepth]
 * @returns {Array<{pid: number, parentPid: number, name: string, exe: string|null, depth: number, creationTicks: string}>}
 */
export function descendantsOf({ host, table, observedAtTicks, maxDepth = MAX_DESCENDANT_DEPTH }) {
  if (!host || !Array.isArray(table)) return []
  let hostTicks
  try { hostTicks = BigInt(host.creationTicks) } catch { return [] }
  const byParent = new Map()
  for (const row of table) {
    if (!byParent.has(row.parentPid)) byParent.set(row.parentPid, [])
    byParent.get(row.parentPid).push(row)
  }
  const found = []
  const seen = new Set([host.pid])
  let frontier = [{ pid: host.pid, depth: 0 }]
  while (frontier.length > 0) {
    const next = []
    for (const node of frontier) {
      if (node.depth >= maxDepth) continue
      for (const row of byParent.get(node.pid) ?? []) {
        if (seen.has(row.pid)) continue
        seen.add(row.pid)
        // Time-bounded attribution: created no earlier than the Host, and not
        // after the table was read. A pid that existed before the Host, or was
        // born after this snapshot, is not its descendant.
        if (row.creationTicks < hostTicks || row.creationTicks > observedAtTicks) continue
        found.push({ pid: row.pid, parentPid: row.parentPid, name: row.name, exe: row.exe, depth: node.depth + 1, creationTicks: row.creationTicks.toString() })
        next.push({ pid: row.pid, depth: node.depth + 1 })
      }
    }
    frontier = next
  }
  return found
}

/**
 * Which of a live sample are still alive in a later snapshot.
 *
 * A sampled row counts as a survivor only if the later table holds the SAME pid
 * with the SAME creation time, so a recycled pid is not mistaken for the original
 * process surviving.
 *
 * @param {Array<object>} liveSubtree Rows sampled while the Host was alive.
 * @param {Array<object>} finalRows Rows read after teardown.
 * @returns {Array<object>} The rows still present.
 */
export function survivingDescendants(liveSubtree, finalRows) {
  if (!Array.isArray(liveSubtree) || !Array.isArray(finalRows)) return []
  const present = new Map(finalRows.map(row => [row.pid, row.creationTicks.toString()]))
  return liveSubtree.filter(row => present.get(row.pid) === row.creationTicks)
}

/**
 * Account for what every Host this fixture spawned left behind.
 *
 * This is deliberately an accounting, not a cleanup. Nothing here terminates
 * anything: a descendant cannot be proven to be this fixture's to kill without the
 * same identity argument used for the direct child, and a wrong kill is far worse
 * than a recorded leftover.
 *
 * Each host must supply a LIVE sample — the subtree read while it was still
 * running. Without that sample the verdict is `not-verified`, because walking the
 * final table alone cannot see past an exited intermediary.
 *
 * WHAT THIS DOES NOT PROVE, stated so it cannot be mistaken for a guarantee: the
 * verdict covers exactly the processes present in the live sample. A descendant
 * created after the sample was taken is outside coverage. That is a limit of the
 * measurement, not a defect to tune away, and `coverage` reports it verbatim.
 *
 * @param {object} options
 * @param {Array<{label: string, pid: number, identity: object|null, exited: boolean,
 *   liveSubtree: Array<object>|null, samplePhase: string}>} options.hosts
 * @param {{available: boolean, rows: Array<object>, reason: string}} options.finalSnapshot
 * @returns {{verified: boolean, reason: string, coverage: string[], perHost: Array<object>, survivors: Array<object>}}
 */
export function assessDescendants({ hosts, finalSnapshot }) {
  const perHost = []
  const survivors = []
  for (const entry of hosts ?? []) {
    if (!finalSnapshot?.available) {
      perHost.push({ label: entry.label, pid: entry.pid, status: 'not-verified', reason: `no post-teardown process table was readable: ${finalSnapshot?.reason ?? 'no snapshot was taken'}`, descendants: [] })
      continue
    }
    if (!entry.identity || entry.identity.available !== true) {
      perHost.push({ label: entry.label, pid: entry.pid, status: 'not-verified', reason: 'the Host identity was never established, so nothing could be attributed', descendants: [] })
      continue
    }
    if (entry.exited !== true) {
      perHost.push({ label: entry.label, pid: entry.pid, status: 'not-verified', reason: 'the Host did not exit, so its descendants were never settled', descendants: [] })
      continue
    }
    if (!Array.isArray(entry.liveSubtree)) {
      perHost.push({ label: entry.label, pid: entry.pid, status: 'not-verified', reason: `no live sample was taken (${entry.samplePhase ?? 'no phase recorded'}), so the tree cannot be reconstructed after teardown: an exited intermediary hides everything below it`, descendants: [] })
      continue
    }
    const survivorsHere = survivingDescendants(entry.liveSubtree, finalSnapshot.rows)
    perHost.push({
      label: entry.label,
      pid: entry.pid,
      status: survivorsHere.length === 0 ? 'proven-empty' : 'left-behind',
      samplePhase: entry.samplePhase ?? 'unknown',
      sampledDescendants: entry.liveSubtree.length,
      descendants: survivorsHere,
    })
    survivors.push(...survivorsHere.map(row => ({
      label: entry.label,
      pid: row.pid,
      reason: `process ${row.name} (${row.exe ?? '<unreadable path>'}) was sampled at depth ${row.depth} under the Host pid ${entry.pid} and is still running after teardown`,
      action: 'recorded, NOT terminated: a descendant cannot be proven owned for killing without its own fresh spawn-time attestation',
    })))
  }
  // Verified means every single Host was proven to have left nothing behind.
  // An unprovable host is NOT a pass, however few there are.
  const unverified = perHost.filter(entry => entry.status !== 'proven-empty')
  const verified = finalSnapshot?.available === true && perHost.length > 0 && unverified.length === 0
  const reason = verified
    ? 'every Host exited, and no process sampled under it while it was alive survives the post-teardown snapshot'
    : survivors.length > 0
      ? `${survivors.length} sampled descendant(s) outlived their Host`
      : unverified.length > 0
        ? `descendant cleanup not verified for ${unverified.length} of ${perHost.length} Host(s): ${unverified[0].reason}`
        : 'no Host was recorded, so nothing could be verified'
  return {
    verified,
    reason,
    coverage: [
      'The verdict covers exactly the processes present in each Host\'s live sample. A descendant created after that sample is outside coverage.',
      'Attribution is by parent id and creation time; a process re-parented away from the Host, or launched detached, is not attributed and is not covered either.',
      'Each Host is accounted separately. A browser or other non-Host process belongs to whoever launched it and must be recorded as its own entry, not folded into a Host.',
    ],
    perHost,
    survivors,
  }
}

/** Total rows read by the snapshot probe, for the evidence record. */
export const SETTLE_ATTEMPTS = 5

/**
 * Re-read the table until no descendant remains, up to a bounded number of
 * attempts.
 *
 * Windows attaches a console host (`conhost.exe`) beneath any console process.
 * It is not a product leftover, but it is genuinely in the tree, and it can
 * outlive its parent by a few hundred milliseconds. Waiting a bounded moment for
 * the tree to settle is not the same as lowering the bar: what is asserted is
 * still "no owned descendant remains", and a survivor that does not clear inside
 * the window is still a failure. The attempt count is reported so a run that only
 * passed on the last try is visible as such.
 *
 * @param {object} options
 * @param {Array<object>} options.hosts
 * @param {() => Promise<object>} [options.capture] Injected snapshot source.
 * @param {number} [options.attempts]
 * @param {number} [options.delayMs]
 * @param {(ms: number) => Promise<void>} [options.sleep]
 * @returns {Promise<{verified: boolean, attempts: number, snapshot: object, assessment: object}>}
 */
export async function settleDescendants({ hosts, capture = captureProcessTable, attempts = SETTLE_ATTEMPTS, delayMs = 1000, sleep }) {
  const wait = sleep ?? (ms => new Promise((done) => { setTimeout(done, ms) }))
  let snapshot = null
  let assessment = null
  let used = 0
  for (let attempt = 1; attempt <= Math.max(1, attempts); attempt += 1) {
    used = attempt
    snapshot = await capture()
    assessment = assessDescendants({ hosts, finalSnapshot: snapshot })
    if (assessment.verified) break
    if (attempt < attempts) await wait(delayMs)
  }
  return { verified: assessment.verified, attempts: used, snapshot, assessment }
}