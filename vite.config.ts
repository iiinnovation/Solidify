import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    host: '127.0.0.1',
    strictPort: true,
  },
  envPrefix: ['VITE_', 'TAURI_'],
  test: {
    // jsdom：组件测试与依赖 localStorage / window 的模块需要
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    // 只跑本项目的测试，避免扫到 src-tauri 或外部参考目录
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['node_modules', 'dist', 'src-tauri'],
  },
})
