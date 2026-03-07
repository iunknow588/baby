import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [
    vue({
      template: {
        compilerOptions: {
          isCustomElement: tag => tag === 'vue-advanced-chat' || tag === 'emoji-picker'
        }
      }
    })
  ],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return
          if (id.includes('vue-advanced-chat')) return 'chat-ui'
          if (id.includes('/vue/') || id.includes('vue-router') || id.includes('pinia')) {
            return 'vue-core'
          }
          return 'vendor'
        }
      }
    }
  }
})
