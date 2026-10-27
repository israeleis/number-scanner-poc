/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import basicSsl from '@vitejs/plugin-basic-ssl'
import { existsSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Plugin } from 'vite'

// `npm run lab`: the app is served from this machine over HTTPS (a phone camera needs HTTPS) and
// every scan the phone saves is written to data/scans/ here, instead of to Google Sheets.
const LAB = process.env.LOCAL_LAB === '1'

function labServer(): Plugin {
  const root = join(process.cwd(), 'data', 'scans')
  return {
    name: 'lab-server',
    configureServer(server) {
      server.middlewares.use('/number-scanner-poc/api/scans', (req, res) => {
        const reply = (body: object) => {
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(body))
        }
        if (req.method === 'GET') return reply({ ok: true, sheet: `this computer (${root})` })
        let raw = ''
        req.on('data', (c) => (raw += c))
        req.on('end', () => {
          try {
            const body = JSON.parse(raw)
            const r = body.record
            const dir = join(root, `${String(r.createdAt).replace(/[:.]/g, '-')}_${r.id}`)
            // The app retries until it hears back, so the same scan can arrive twice.
            if (existsSync(dir)) return reply({ ok: true, duplicate: true })
            mkdirSync(dir, { recursive: true })
            const save = (b64: string, name: string) => {
              if (b64) writeFileSync(join(dir, name), Buffer.from(b64, 'base64'))
            }
            save(body.original, 'original.jpg')
            save(body.processed, 'processed.jpg')
            ;(body.crops ?? []).forEach((b64: string, i: number) => save(b64, `label-${i + 1}.jpg`))
            writeFileSync(join(dir, 'record.json'), JSON.stringify(r, null, 2))
            appendFileSync(join(root, 'index.jsonl'), JSON.stringify({ dir, id: r.id, createdAt: r.createdAt, mode: r.mode, outcome: r.outcome, summary: r.summary }) + '\n')
            reply({ ok: true })
          } catch (e) {
            res.statusCode = 400
            reply({ ok: false, error: String(e) })
          }
        })
      })
    },
  }
}

export default defineConfig({
  define: {
    __BUILD__: JSON.stringify(new Date().toISOString().slice(0, 16)),
    __LAB__: JSON.stringify(LAB),
  },
  server: LAB ? { host: '0.0.0.0', port: 5443, strictPort: true } : undefined,
  base: '/number-scanner-poc/',
  plugins: [
    ...(LAB ? [basicSsl(), labServer()] : []),
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
