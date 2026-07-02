import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

// The Go server embeds dist/ via `//go:embed all:dist`, which fails to compile if
// dist/ is empty (fresh checkout, CI `go` job). We keep a tracked dist/.gitkeep as a
// placeholder, but emptyOutDir wipes it on build — so regenerate it after each build.
function keepDistPlaceholder() {
  return {
    name: 'keep-dist-placeholder',
    closeBundle() {
      writeFileSync(resolve(__dirname, 'dist/.gitkeep'), '')
    },
  }
}

// base is injected at build time so the SPA can mount under a subpath.
export default defineConfig({
  plugins: [react(), keepDistPlaceholder()],
  base: process.env.DASH_BASE_PATH || '/',
  build: { outDir: 'dist', emptyOutDir: true },
})
