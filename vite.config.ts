import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import dotenv from 'dotenv'
import path from 'node:path'
import { defineConfig } from 'vite'

const serverEnv = dotenv.config({
  path: path.resolve(process.cwd(), 'server', '.env'),
  quiet: true,
}).parsed
const apiPort = process.env.PORT || serverEnv?.PORT || '4000'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    babel({ presets: [reactCompilerPreset()] })
  ],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': {
        target: `http://localhost:${apiPort}`,
        changeOrigin: true,
      },
      '/socket.io': {
        target: `http://localhost:${apiPort}`,
        changeOrigin: true,
        ws: true,
      },
    },
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
  },
})
