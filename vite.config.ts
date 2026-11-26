import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { librarySyncProxyPlugin } from './src/server/libraryProxy'

export default defineConfig({
  plugins: [vue(), tailwindcss(), librarySyncProxyPlugin()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/pinyin-pro')) {
            return 'vendor-pinyin'
          }
          if (id.includes('node_modules/sm-crypto')) {
            return 'vendor-crypto'
          }
          if (id.includes('node_modules/vue') || id.includes('node_modules/lucide-vue-next')) {
            return 'vendor-ui'
          }
        },
      },
    },
  },
  server: {
    port: 5173,
    host: true,
    watch: {
      ignored: ['**/.cover-cache.json'],
    },
  },
})
