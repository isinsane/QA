import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The API runs separately (`go run ./cmd/api`); the proxy keeps the browser
// on one origin in dev, as it is in production.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      '/api': { target: process.env.API_URL ?? 'http://localhost:8090', changeOrigin: true },
    },
  },
})
