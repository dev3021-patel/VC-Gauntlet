import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

export default defineConfig(({ mode }) => {
  // VITE_BACKEND_PROXY=http://127.0.0.1:8000 makes the dev server forward /api/* to a
  // local backend, so a tunnelled preview (VITE_BACKEND_URL=/api) reaches it too.
  const env = loadEnv(mode, '.', '')
  const proxyTarget = (env.VITE_BACKEND_PROXY ?? '').trim()

  return {
    plugins: [react()],
    server: {
      host: '127.0.0.1',
      allowedHosts: true,
      hmr: env.VITE_HMR_CLIENT_PORT
        ? { clientPort: Number(env.VITE_HMR_CLIENT_PORT) }
        : undefined,
      proxy: proxyTarget
        ? {
            '/api': {
              target: proxyTarget,
              changeOrigin: true,
              ws: true,
              rewrite: (path) => path.replace(/^\/api/, ''),
            },
          }
        : undefined,
    },
  }
})
