import type { UserConfig } from 'tsdown'
import {
  requestedExternals,
} from '../.upstream/packages/client/tsdown.client.ts'
import {
  PLATFORM_MODULES,
  PRELOADED_CLIENT_EXTERNALS,
} from '../.upstream/packages/client/web/src/platform.ts'
import { clientBuildEnvironmentDefines } from '../.upstream/scripts/client-build-environment.ts'

/** Emit the port-owned Host and Client halves using upstream's loader conventions. */
export function portClientBundle(id: string, clientEntry: string): UserConfig[] {
  const clientDeclaration = { external: [] as string[] }
  const tableExternals = new Set([
    ...PLATFORM_MODULES,
    ...PRELOADED_CLIENT_EXTERNALS,
    ...requestedExternals(id, clientDeclaration),
  ])
  const node: UserConfig = {
    name: `${id}/node`,
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    sourcemap: false,
    clean: true,
  }
  const client: UserConfig = {
    name: `${id}/client`,
    entry: { client: clientEntry },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    fixedExtension: false,
    dts: false,
    sourcemap: true,
    clean: false,
    deps: {
      neverBundle: (specifier: string) => tableExternals.has(specifier),
      alwaysBundle: (specifier: string) => !tableExternals.has(specifier),
    },
    define: {
      ...clientBuildEnvironmentDefines(process.env),
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
    outputOptions: {
      entryFileNames: 'client.js',
      chunkFileNames: 'client.[name].js',
      sourcemapExcludeSources: false,
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  }
  return [node, client]
}
