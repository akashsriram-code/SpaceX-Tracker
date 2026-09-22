import { defineConfig } from 'vite'
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
})
