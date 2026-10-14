// Cordis declares FiberState as a `const enum` (`vendor/cordis/src/fiber.ts`):
// ACTIVE is inlined as a NUMBER in Cordis' own compiled code and FiberState is
// not a JavaScript export. A standalone tsdown overlay can leave the value
// import in ConfigEditor, which then fails at runtime against an undefined
// `FiberState`. Repair only that known generated shape; retain the lifecycle
// refusal.
//
// The inlined constant is NOT a guess. Each reviewed Cordis release records the
// index of ACTIVE in its declared member order, and a version absent from the
// table is refused, so an unreviewed release can never have an enum value
// transcribed on its behalf. Both entries below were read from the vendored
// source of their own checkout:
//
//   4.0.4         members [PENDING, LOADING, ACTIVE, FAILED, DISPOSED, UNLOADING] -> ACTIVE 2
//   4.0.5-alpha.1 members [PENDING, LOADING, ACTIVE, FAILED, DISPOSED, UNLOADING] -> ACTIVE 2
//
// `port/tests/packaging/config-editor-runtime-import.test.mjs` re-derives that
// index from the reference checkout, so this table cannot drift from the source
// it claims to describe.
export const REVIEWED_CORDIS_FIBER_STATES = Object.freeze({
  '4.0.4': 2,
  '4.0.5-alpha.1': 2,
})

/**
 * Repair the erased const-enum value import in compiled ConfigEditor source.
 *
 * @param source - the compiled `@deepseek-ai/dsh-config-editor/lib/index.js` text.
 * @param cordisVersion - the Cordis version the payload actually materialized.
 * @param reviewed - reviewed version-to-ACTIVE map; a seam for the value test.
 * @returns `{ changed, source }`; `changed` is false when nothing needed repair.
 */
export function repairConfigEditorRuntimeImport(source, cordisVersion, reviewed = REVIEWED_CORDIS_FIBER_STATES) {
  if (typeof source !== 'string') throw new TypeError('ConfigEditor source must be a string');
  if (!Object.hasOwn(reviewed, cordisVersion ?? '')) {
    throw new Error(`Unreviewed Cordis version '${String(cordisVersion)}'; refusing const-enum transcription`);
  }
  const active = reviewed[cordisVersion];
  if (!Number.isSafeInteger(active) || active < 0) {
    throw new Error(`Reviewed Cordis FiberState.ACTIVE must be a non-negative integer, found ${String(active)}`);
  }
  const importLine = 'import { FiberState, Service, resolveConfig } from "@deepseek-ai/cordis";';
  const guard = 'fiber.state !== FiberState.ACTIVE';
  if (!source.includes('FiberState')) return { changed: false, source };
  if (source.split(importLine).length !== 2 || source.split(guard).length !== 2
      || (source.match(/\bFiberState\b/g) ?? []).length !== 2) {
    throw new Error('Unreviewed ConfigEditor FiberState shape; refusing transformation');
  }
  return {
    changed: true,
    source: source.replace(importLine, 'import { Service, resolveConfig } from "@deepseek-ai/cordis";')
      .replace(guard, `fiber.state !== ${active} /* Cordis ${cordisVersion} ACTIVE */`),
  };
}
