/** Narrow adapter for the pinned account plugin; preserves the upstream checkout. */
import { createHash } from 'node:crypto'

// Reviewed compiled getProfile bodies per EXPLICIT release literal: the accepted
// upstream body first, then the previous portable disk fallback where that
// legacy input is still reviewed (0.1.7-rc.2 only). A package version alone does
// not identify generated code, and a retarget must not re-point a pin.
// 0.2.1-alpha.3 compiled getProfile is byte-identical to 0.2.1-alpha.2.
const ACCEPTED_GET_PROFILE = '3628899fd423bb6838586f915d7da7ee5b96de6e371546f95a4944ec4f3f97b2'
const LEGACY_PORTABLE_GET_PROFILE = '54a8fea5cf2d53d1fb9fab30c2464f8fa858879acd528ce38b149ef5de52f91f'
const reviewedGetProfile = new Map([
  ['0.1.7-rc.2', new Set([ACCEPTED_GET_PROFILE, LEGACY_PORTABLE_GET_PROFILE])],
  ['0.2.1-alpha.2', new Set([ACCEPTED_GET_PROFILE])],
  ['0.2.1-alpha.3', new Set([ACCEPTED_GET_PROFILE])],
])

export function repairAccountProfileRuntime(source, version) {
  // The target getProfile is byte-identical to the reviewed upstream body.
  // The legacy portable disk fallback is not an accepted target input.
  const methods = reviewedGetProfile.get(version)
  if (!methods) throw new Error('Unreviewed account plugin version')
  source = source.replaceAll('\r\n', '\n')
  const start = '\tasync getProfile(client) {'
  const end = '\n\tgetBalance(client) {'
  const first = source.indexOf(start), last = source.indexOf(end, first)
  if (first < 0 || last < 0 || source.indexOf(start, first + 1) >= 0) throw new Error('Unreviewed account getProfile shape')
  const method = source.slice(first, last)
  const repaired = `\tasync getProfile(client) {
    // DSH_PORT_CACHED_PROFILE_REFRESH: show only this grant's last known data
    // immediately; background refresh still expires rejected credentials.
    const lifetime = this.detailsLifetime;
    const stored = await this.readCurrentGrant(lifetime);
    if (stored === null || lifetime.signal.aborted) return null;
    const cached = this.lastProfile?.token === stored.token ? this.lastProfile.profile : loadPersistedAccountProfile(stored.token);
    if (cached !== undefined) {
      if (this.lastProfile?.token !== stored.token) this.cacheProfile(stored.token, cached);
      const pending = this.profileRefreshInFlight;
      if (pending === undefined || pending.lifetime !== lifetime || pending.token !== stored.token) {
        const refresh = { lifetime, token: stored.token, promise: undefined };
        const refreshing = this.getDetail("profile", this.detailHeaders(client), { lifetime, stored }).then(result => {
          if (this.detailsLifetime === lifetime && result?.status === "ready") this.cacheProfile(stored.token, result);
        }, () => {}).finally(() => {
          if (this.profileRefreshInFlight === refresh) this.profileRefreshInFlight = undefined;
        });
        refresh.promise = refreshing;
        this.profileRefreshInFlight = refresh;
      }
      return cached;
    }
    const result = await this.getDetail("profile", this.detailHeaders(client), { lifetime, stored });
    if (this.detailsLifetime !== lifetime) return null;
    if (result !== null) this.cacheProfile(stored.token, result);
    return result;
  }`
  if (source.includes('DSH_PORT_CACHED_PROFILE_REFRESH')) {
    if (method !== repaired) throw new Error('Unreviewed cached account getProfile shape')
    return { source, changed: false }
  }
  if (!methods.has(createHash('sha256').update(method).digest('hex'))) {
    throw new Error('Unreviewed account getProfile semantics')
  }
  let output = source.slice(0, first) + repaired + source.slice(last)
  const imported = 'import { persistAccountProfile, loadPersistedAccountProfile } from "./profile-cache.js";'
  if (!output.includes(imported)) output = `${imported}\n${output}`
  const anchor = '\t\tthis.lastProfile = {\n\t\t\ttoken,\n\t\t\tprofile\n\t\t};'
  if (!output.includes('persistAccountProfile(token, profile)')) {
    if (output.split(anchor).length !== 2) throw new Error('Unreviewed account profile cache shape')
    output = output.replace(anchor, `${anchor}\n\t\tpersistAccountProfile(token, profile);`)
  }
  return { source: output, changed: true }
}
