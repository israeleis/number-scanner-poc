/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  define: { __BUILD__: JSON.stringify(new Date().toISOString().slice(0, 16)) },
  base: '/number-scanner-poc/',
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'סורק מספרים',
        short_name: 'סורק',
        description: 'POC: זיהוי מספרים במצלמה',
        lang: 'he',
        dir: 'rtl',
        display: 'standalone',
        background_color: '#111111',
        theme_color: '#111111',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png}'],
        // The models and the runtime are large: cached on first use instead of at install.
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.includes('/models/') || url.pathname.includes('/ort/'),
            handler: 'CacheFirst',
            options: { cacheName: 'ocr-models', expiration: { maxEntries: 10 } },
          },
        ],
      },
    }),
  ],
  test: { include: ['src/**/*.test.ts'] },
})
