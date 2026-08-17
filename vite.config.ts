import { defineConfig, type Plugin } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

const MODEL_PROXY_PATH = '/__solidify/model-proxy'

function localModelProxy(): Plugin {
  return {
    name: 'solidify-local-model-proxy',
    configureServer(server) {
      server.middlewares.use(MODEL_PROXY_PATH, async (request, response) => {
        if (request.method !== 'POST') {
          response.statusCode = 405
          response.end('Method not allowed')
          return
        }

        const targetHeader = request.headers['x-solidify-target']
        const target = Array.isArray(targetHeader) ? targetHeader[0] : targetHeader
        try {
          if (!target) throw new Error('缺少模型服务地址')
          const targetUrl = new URL(target)
          if (!/^https?:$/.test(targetUrl.protocol)) throw new Error('模型服务地址必须使用 http(s)')

          const chunks: Buffer[] = []
          for await (const chunk of request) chunks.push(Buffer.from(chunk))
          const headers: Record<string, string> = {
            'content-type': request.headers['content-type'] ?? 'application/json',
          }
          for (const name of ['authorization', 'x-api-key', 'anthropic-version']) {
            const value = request.headers[name]
            if (typeof value === 'string') headers[name] = value
          }

          const upstream = await fetch(targetUrl, {
            method: 'POST',
            headers,
            body: Buffer.concat(chunks),
          })
          response.statusCode = upstream.status
          for (const name of ['content-type', 'cache-control']) {
            const value = upstream.headers.get(name)
            if (value) response.setHeader(name, value)
          }
          response.setHeader('x-accel-buffering', 'no')
          response.flushHeaders()
          if (upstream.body) {
            for await (const chunk of upstream.body) response.write(Buffer.from(chunk))
          }
          response.end()
        } catch (error) {
          if (response.headersSent) {
            response.end()
            return
          }
          response.statusCode = 502
          response.setHeader('content-type', 'application/json; charset=utf-8')
          response.end(JSON.stringify({
            error: { message: error instanceof Error ? error.message : '模型代理请求失败' },
          }))
        }
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), localModelProxy()],
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
