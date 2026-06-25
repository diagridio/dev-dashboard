import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// base is injected at build time so the SPA can mount under a subpath.
export default defineConfig({
  plugins: [react()],
  base: process.env.DASH_BASE_PATH || '/',
  build: { outDir: 'dist', emptyOutDir: true },
})
