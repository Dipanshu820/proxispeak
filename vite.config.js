import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The account cookie, session and ICE endpoints are called same-origin (`/api/...`)
// and Socket.IO is proxied at `/socket.io`, so the browser never depends on CORS
// for authentication and the built app has no hard-coded backend host.
//
// A production deployment serves the built assets, `/api` and `/socket.io` from
// one origin. Set VITE_API_PROXY/VITE_SOCKET_PROXY only when the local backend
// lives somewhere other than http://localhost:4000, or VITE_SOCKET_URL when the
// socket really is on a different origin (then CLIENT_ORIGIN must include this
// frontend).
const API_TARGET = process.env.VITE_API_PROXY || 'http://localhost:4000'
const SOCKET_TARGET = process.env.VITE_SOCKET_PROXY || API_TARGET
const SOCKET_URL = process.env.VITE_SOCKET_URL || ''

const proxy = {
  '/api': { target: API_TARGET, changeOrigin: true },
  '/socket.io': { target: SOCKET_TARGET, ws: true, changeOrigin: true },
}

export default defineConfig({
  plugins: [react()],
  define: {
    'import.meta.env.VITE_SOCKET_URL': JSON.stringify(SOCKET_URL),
  },
  server: { proxy },
  preview: { proxy },
})
