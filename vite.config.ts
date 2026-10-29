import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * GitHub Pages base path.
 *
 * A project site is served from https://<user>.github.io/<repo>/, so assets
 * must be requested from `/<repo>/`. We derive that from GITHUB_REPOSITORY
 * (set automatically by Actions) so there is nothing to hand-edit when the
 * repo is renamed or forked. A user/org site (<user>.github.io) is served
 * from the domain root, so it keeps `/`.
 *
 * Outside CI we use './' so `vite preview` and opening dist/ locally work.
 * Override explicitly with VITE_BASE if you deploy somewhere unusual.
 */
function resolveBase(): string {
  if (process.env.VITE_BASE) return process.env.VITE_BASE
  if (!process.env.GITHUB_ACTIONS) return './'

  const repo = (process.env.GITHUB_REPOSITORY ?? '').split('/')[1] ?? ''
  if (!repo) return './'
  // <user>.github.io repos are root-hosted, not served under a subpath.
  if (repo.endsWith('.github.io')) return '/'
  return `/${repo}/`
}

export default defineConfig({
  base: resolveBase(),
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
  // The SGP4 worker is created with { type: 'module' } and imports
  // satellite.js (ESM-only), so its bundle must be ES too; Vite's default
  // 'iife' can't code-split a worker.
  worker: {
    format: 'es',
    plugins: () => [noSatelliteWasm()],
  },
  // Same WASM builds, dev side: esbuild's pre-bundling follows those dynamic
  // imports and fails on their top-level await. satellite.js is plain ESM, so
  // serving it unbundled costs nothing, and the WASM files are never fetched.
  optimizeDeps: { exclude: ['satellite.js'] },
})

/**
 * satellite.js re-exports an optional WASM bulk propagator whose loaders
 * dynamic-import two Emscripten builds (~1 MB, Node-only imports, top-level
 * await). We only use the plain-JS SGP4, but Rollup keeps dynamic-import
 * targets even when nothing calls them, and their top-level await fails the
 * build. Swap them for a stub that throws if anything ever does.
 */
function noSatelliteWasm(): Plugin {
  const STUB = '\0satellite-wasm-stub'
  return {
    name: 'no-satellite-wasm',
    enforce: 'pre',
    resolveId: (id) => (id === '#wasm-single-thread' || id === '#wasm-multi-thread' ? STUB : null),
    load: (id) =>
      id === STUB
        ? 'export default () => { throw new Error("satellite.js WASM runtime is not bundled") }'
        : null,
  }
}
