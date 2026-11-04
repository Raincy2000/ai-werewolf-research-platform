
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')

export default defineConfig({
  base: './',
  root: __dirname,
  plugins: [react()],
  resolve: {
    alias: [
      // 先精确匹配 mock，再走通用别名
      { find: /^@\/lib\/gameApi$/, replacement: path.resolve(__dirname, 'mockGameApi.ts') },
      { find: /^@\//, replacement: path.resolve(root, 'src') + '/' },
      { find: /^@contracts\//, replacement: path.resolve(root, 'contracts') + '/' },
      { find: /^@db\//, replacement: path.resolve(root, 'db') + '/' },
    ],
  },
  build: {
    outDir: path.resolve(__dirname, 'dist'),
    emptyOutDir: true,
    rollupOptions: { input: path.resolve(__dirname, 'index.html') },
  },
})
