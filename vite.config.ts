import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  plugins: [react()],
  build: {
    lib: {
      entry: resolve(__dirname, 'src/widget-entry.tsx'),
      name: 'AgentsFloorWidget',
      // Single output file: dist/widget.js (IIFE, self-contained)
      fileName: () => 'widget.js',
      formats: ['iife'],
    },
    rollupOptions: {
      // Bundle React — do NOT externalize; widget must be fully self-contained
      output: {
        inlineDynamicImports: true,
      },
    },
    minify: 'esbuild',
    sourcemap: false,
  },
  // Required for React in production IIFE bundle
  define: {
    'process.env.NODE_ENV': '"production"',
  },
})
