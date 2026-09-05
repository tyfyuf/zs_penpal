import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        // Force OpenAI's auto shim to use Web Fetch and avoid loading node-fetch.
        'openai/_shims/auto/runtime': resolve('node_modules/openai/_shims/auto/runtime.js')
      }
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          'summary-worker': resolve('src/main/services/summary-worker.ts')
        },
        output: {
          entryFileNames: '[name].js'
        }
      }
    },
    plugins: [
      externalizeDepsPlugin({
        include: ['@huggingface/transformers', 'onnxruntime-node', 'onnxruntime-web']
      })
    ]
  },
  preload: {
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react(), tailwindcss()]
  }
})
