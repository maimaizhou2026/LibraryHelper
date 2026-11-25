import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { librarySyncProxyPlugin } from './src/server/libraryProxy'

export default defineConfig({
  plugins: [vue(), tailwindcss(), librarySyncProxyPlugin()],
  server: {
    port: 5173,
    host: true,
    watch: {
      ignored: ['**/.cover-cache.json'],
    },
  },
})
