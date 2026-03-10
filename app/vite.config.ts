import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  server: {
    proxy: {
      // Dev only: proxy /api to local Vercel Functions runtime.
      '/api': {
        target: 'http://127.0.0.1:4010',
        changeOrigin: true
      }
    }
  },
  build: {
    chunkSizeWarningLimit: 650,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return
          if (id.includes('/vue/') || id.includes('vue-router') || id.includes('pinia')) {
            return 'vue-core'
          }
          return 'vendor'
        }
      }
    }
  }
})
