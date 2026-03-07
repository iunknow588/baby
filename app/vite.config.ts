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
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:9000',
        changeOrigin: true
      }
    }
  },
  build: {
    // vue-advanced-chat 本身是较大的 web component 包，且仅在 /chat 路由懒加载
    // 适当提高 warning 阈值，避免将预期行为误判为发布阻塞项
    chunkSizeWarningLimit: 650,
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
