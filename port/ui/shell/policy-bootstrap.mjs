/** Build-time policy inputs copied from the application package and the exact UI defines. */

/**
 * Produce native-readable metadata without consulting runtime environment or renderer state.
 * @param {Record<string, unknown>} applicationPackage Trusted desktop application package JSON.
 * @param {Readonly<Record<string, string>>} buildDefines Exact defines supplied to the UI bundler.
 * @returns {{schemaVersion: 1, clientVersion: string | null, dshMandatoryUpdatePolicy?: unknown}} Packaged inputs; an absent policy stays absent.
 */
export function createPolicyBootstrap(applicationPackage, buildDefines) {
  if (applicationPackage === null || typeof applicationPackage !== 'object' || Array.isArray(applicationPackage)) {
    throw new Error('desktop policy: application package must be an object')
  }
  const encodedVersion = buildDefines['process.env.DSH_CLIENT_VERSION']
  const clientVersion = encodedVersion === undefined ? null : JSON.parse(encodedVersion)
  if (encodedVersion !== undefined && typeof clientVersion !== 'string') {
    throw new Error('desktop policy: UI client version define must encode a string')
  }
  return {
    schemaVersion: 1,
    clientVersion,
    ...(Object.hasOwn(applicationPackage, 'dshMandatoryUpdatePolicy')
      ? { dshMandatoryUpdatePolicy: applicationPackage.dshMandatoryUpdatePolicy }
      : {}),
  }
}
