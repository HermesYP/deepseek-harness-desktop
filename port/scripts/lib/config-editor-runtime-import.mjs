// Cordis 4.0.4 declares FiberState as a const enum: ACTIVE is inlined as 2
// in its own compiled code and FiberState is not a JavaScript export.
// A standalone tsdown overlay can leave the value import in ConfigEditor.
// Repair only that known generated shape; retain the lifecycle refusal.
export function repairConfigEditorRuntimeImport(source, cordisVersion) {
  if (typeof source !== 'string') throw new TypeError('ConfigEditor source must be a string');
  if (cordisVersion !== '4.0.4') throw new Error('Unreviewed Cordis version; refusing const-enum transcription');
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
      .replace(guard, 'fiber.state !== 2 /* Cordis 4.0.4 ACTIVE */'),
  };
}
