/** Last-known display profile, scoped to the exact grant; never an auth decision. */
import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const MAX_BYTES = 16 * 1024
function filePath() {
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  return join(home, 'cache', 'dsh-desktop-account-profile.json')
}
function key(token) { return createHash('sha256').update(token).digest('hex') }
function normalize(profile) {
  if (profile?.status !== 'ready' || !profile.value || typeof profile.value !== 'object') return undefined
  const value = {}
  for (const field of ['id', 'name', 'contact']) {
    const text = profile.value[field]
    if (text !== null && (typeof text !== 'string' || text.length > 2048)) return undefined
    value[field] = text
  }
  const avatar = profile.value.avatarUrl
  if (avatar !== undefined) {
    if (avatar !== null && (typeof avatar !== 'string' || avatar.length > 4096)) return undefined
    value.avatarUrl = avatar
  }
  return { status: 'ready', value }
}
export function persistAccountProfile(token, profile) {
  let pending
  try {
    if (typeof token !== 'string' || !token) return
    const normalized = normalize(profile)
    if (!normalized) return
    const file = filePath()
    mkdirSync(dirname(file), { recursive: true })
    pending = `${file}.${randomUUID()}.pending`
    writeFileSync(pending, JSON.stringify({ version: 2, key: key(token), savedAt: new Date().toISOString(), profile: normalized }), { flag: 'wx', mode: 0o600 })
    // Replacement never exposes a truncated final file if the process is killed.
    renameSync(pending, file)
    pending = undefined
  } catch { /* display cache failure cannot fail sign-in or settings */ }
  finally { if (pending) { try { unlinkSync(pending) } catch {} } }
}
export function loadPersistedAccountProfile(token) {
  try {
    if (typeof token !== 'string' || !token) return undefined
    const file = filePath()
    const stat = lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) return undefined
    const bytes = readFileSync(file)
    if (bytes.length > MAX_BYTES) return undefined
    const raw = JSON.parse(bytes.toString('utf8'))
    if (raw.version !== 1 && raw.version !== 2) return undefined
    const expected = key(token)
    if (raw.key !== (raw.version === 1 ? expected.slice(0, 32) : expected)) return undefined
    return normalize(raw.profile)
  } catch { return undefined }
}
