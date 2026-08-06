import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('@tiptap') || id.includes('prosemirror')) return 'tiptap'
            if (id.includes('lowlight') || id.includes('highlight.js')) return 'lowlight'
          }
        },
      },
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    // Proxy /api/* to the Hono backend so the browser sees same-origin requests
    // (no CORS roundtrip, cookies Just Work). Backend port matches apps/api/.env.
    // /api/collab 是 Hocuspocus WebSocket 独立端口,转发到 COLLAB_PORT(默认 8788)。
    // 两个 proxy 都加 ws:true —— Vite 在 dev 默认行为不一定走 upgrade 转发,
    // 显式声明避免依赖版本默认值漂移。
    proxy: {
      '/api/collab': {
        target: 'http://127.0.0.1:8788',
        changeOrigin: true,
        ws: true,
      },
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
        ws: true,
      },
    },
  }
})