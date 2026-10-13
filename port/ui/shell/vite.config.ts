/**
 * Vite build of the packaged web-client shell — the port of
 * `_upstream/apps/web/vite.config.ts` with the same `base`, `dedupe`, `define`
 * substitutions, chunk/asset layout, and `brandFontLicense` behaviour, so the
 * emitted `assets/` tree matches the upstream `apps/web/dist` layout exactly.
 *
 * Deltas from upstream (all documented in `../README.md`):
 * - the worker-preview surface (`preview.ts` input, `emitPreviewPage`) and the
 *   `productWebBundleIsolation` build gate are omitted; neither affects the
 *   client served at `/`.
 * - `outDir` is `port/ui/dist` (the artifact the Rust gateway serves) and
 *   `cacheDir` stays under `port/ui/`.
 * - the read-only upstream helpers and license text are referenced in place
 *   through `port/.upstream`, the generated junction `link-toolchain.ps1` points
 *   at the SELECTED checkout (`-UpstreamRoot` / `$env:DSH_UPSTREAM_ROOT`). The
 *   specifiers are static because esbuild inlines them when this config is
 *   bundled, so a runtime-chosen path could never reach them.
 */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'
// Read-only reuse of the upstream build-environment helper (same defines as apps/web).
import { clientBuildEnvironmentDefines } from '../../.upstream/scripts/client-build-environment.ts'
import { createPolicyBootstrap } from './policy-bootstrap.mjs'

const src = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url))
const STANDALONE_ERROR = 'port/ui/shell is not a standalone application: bare Vite cannot inject window.__DSH_BOOT__. '
  + 'Serve the built output through the Rust gateway (shell-owned boot path, docs/contracts/ui-backend-protocol.md §7.3).'
const DEFAULT_CLIENT_TITLE = 'DSH Local Build'
// One snapshot supplies both the actual UI substitutions and native metadata.
const clientBuildDefines = Object.freeze(clientBuildEnvironmentDefines(process.env))

/** Emit only desktop policy inputs, not the rest of the application manifest. */
function desktopPolicyBootstrap(): Plugin {
  let source: string
  return {
    name: 'dsh-desktop-policy-bootstrap',
    async buildStart() {
      const applicationPackage = JSON.parse(await readFile(src('../../.upstream/apps/desktop/package.json'), 'utf8'))
      source = `${JSON.stringify(createPolicyBootstrap(applicationPackage, clientBuildDefines), null, 2)}\n`
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'desktop-policy-bootstrap.json', source })
    },
  }
}

/** Escape build-time text before placing it in the HTML title element. */
function escapeHtmlText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Project the public build title into the initial HTML document. */
function clientDocumentTitle(): Plugin {
  const title = escapeHtmlText(process.env.DSH_CLIENT_TITLE ?? DEFAULT_CLIENT_TITLE)
  return {
    name: 'dsh-client-document-title',
    transformIndexHtml(html) {
      return html.replace('<title>DSH Local Build</title>', `<title>${title}</title>`)
    },
  }
}

/** Keep the redistribution license beside the bundled brand font. */
function brandFontLicense(): Plugin {
  return {
    name: 'dsh-brand-font-license',
    async generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'assets/fonts/Montserrat-OFL.txt',
        source: await readFile(src('../../.upstream/packages/client/ui-theme/src/styles/Montserrat-OFL.txt')),
      })
    },
  }
}

/** Fail before a Vite dev or preview server can expose the boot-manifest-free shell. */
function rejectStandaloneServe(): Plugin {
  return {
    name: 'dsh-reject-standalone-web-serve',
    config(_config, env) {
      if (env.command === 'serve') throw new Error(STANDALONE_ERROR)
    },
  }
}

/**
 * Vendor-chunk membership, by exact npm package name — the heavy render
 * families (math, highlight, markdown) that change only on dependency bumps.
 * Ported verbatim from upstream so chunk layout and hashes stay comparable.
 */
const VENDOR_PACKAGES: ReadonlySet<string> = new Set([
  // math
  'katex',
  // syntax highlight (@shikijs/langs is handled separately below —
  // lazy grammars must not land here)
  'shiki',
  // markdown parse pipeline (micromark/mdast; the incremental React renderer
  // over it is workspace code)
  'mdast-util-from-markdown',
  'mdast-util-gfm',
  'mdast-util-math',
  'micromark-core-commonmark',
  'micromark-extension-gfm',
  'micromark-extension-math',
  'micromark-factory-space',
  'micromark-util-character',
  'micromark-util-classify-character',
  'micromark-util-sanitize-uri',
  'micromark-util-symbol',
  'micromark-util-types',
])

/**
 * Boot grammars statically imported by ui-primitives' highlight.ts. They live
 * in the same package as the lazy read-card grammars, but unlike those they are
 * part of the initial load and belong in the vendor chunk.
 */
const BOOT_GRAMMAR_FILES: readonly string[] = [
  'dist/typescript.mjs',
  'dist/shellscript.mjs',
  'dist/json.mjs',
]

/** Font asset extensions routed to assets/fonts/ (KaTeX's woff2/woff/ttf faces). */
const FONT_EXTENSIONS: readonly string[] = ['.woff2', '.woff', '.ttf']

/**
 * npm package name of a resolved module id: the segment after the last
 * `node_modules/`. pnpm nests the real package under an inner node_modules.
 */
function npmPackageOf(id: string): string | undefined {
  const parts = id.split('/node_modules/')
  if (parts.length === 1) return undefined
  const [first, second] = parts[parts.length - 1].split('/')
  if (first.startsWith('.')) return undefined // .pnpm store segment, not a package
  if (first.startsWith('@')) return second === undefined ? undefined : `${first}/${second}`
  return first
}

export default defineConfig({
  // The shell directory is the Vite root wherever the build is invoked from.
  root: src('.'),
  // Relative asset URLs: the packaged shell mounts under any base directory,
  // and the served index resolves identically from the site root.
  base: './',
  cacheDir: src('../.cache/vite'),
  plugins: [
    rejectStandaloneServe(), clientDocumentTitle(), brandFontLicense(), desktopPolicyBootstrap(), react(),
  ],
  build: {
    outDir: src('../dist'),
    emptyOutDir: true,
    // The upstream build targets es2022 (the worker bootstrap uses top-level
    // await); keeping the target also keeps transpiled output comparable.
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      input: {
        index: src('./index.html'),
      },
      output: {
        entryFileNames(chunk): string {
          return chunk.name === 'bootstrap' ? 'preview/[name]-[hash].js' : 'assets/[name]-[hash].js'
        },
        // Output layout (upstream verbatim): the main chunks stay at assets/
        // root; lazy @shikijs/langs grammar chunks group under assets/langs/;
        // fonts group under assets/fonts/.
        chunkFileNames(chunk): string {
          if (chunk.name === 'index' || chunk.name === 'vendor') return 'assets/[name]-[hash].js'
          const isLangChunk = chunk.moduleIds.some(id => id.includes('/node_modules/@shikijs/langs/'))
          return isLangChunk ? 'assets/langs/[name]-[hash].js' : 'assets/[name]-[hash].js'
        },
        assetFileNames(asset): string {
          const fileName = asset.names[0] ?? ''
          const isFont = FONT_EXTENSIONS.some(ext => fileName.endsWith(ext))
          return isFont ? 'assets/fonts/[name]-[hash][extname]' : 'assets/[name]-[hash][extname]'
        },
        manualChunks(id: string): string | undefined {
          const pkg = npmPackageOf(id)
          if (pkg === undefined) return undefined // workspace + vendored cordis: index
          if (pkg === '@shikijs/langs') {
            return BOOT_GRAMMAR_FILES.some(file => id.endsWith(`/${file}`)) ? 'vendor' : undefined
          }
          return VENDOR_PACKAGES.has(pkg) ? 'vendor' : undefined
        },
      },
    },
  },
  worker: {
    rollupOptions: { output: { entryFileNames: 'preview/[name]-[hash].js' } },
  },
  resolve: {
    // One instance per shared npm identity (upstream verbatim rationale).
    dedupe: ['react', 'react-dom'],
    alias: [
      { find: /^node:module$/, replacement: src('./src/node-module-stub.ts') },
    ],
  },
  define: {
    ...clientBuildDefines,
    // vendored loader internal.ts: fromInternal() probes the Node major —
    // "0.0.0" takes neither branch, returning undefined (exactly the empty
    // internal slot the shell boot fills with the client module loader).
    'process.versions.node': '"0.0.0"',
    'process.execArgv': '[]',
    // vendored loader index.ts: envData falls to its default branch.
    'process.env.CORDIS_SHARED': 'undefined',
  },
})
