import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'Reckon',
        short_name: 'Reckon',
        description: 'Reality keeps score.',
        theme_color: '#0B0D17',
        background_color: '#0B0D17',
        display: 'standalone',
        start_url: '/',
        icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }],
      },
      workbox: {
        // Web Push notifications (spec §1.5) are shown by this small handler.
        importScripts: ['push-sw.js'],
        // Keep the latest brief readable offline (spec §12, PWA behaviour).
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.startsWith('/api/v1/brief'),
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'brief', expiration: { maxEntries: 10, maxAgeSeconds: 86_400 } },
          },
        ],
      },
    }),
  ],
  server: { port: 5173, proxy: { '/api': process.env.RECKON_API_URL ?? 'http://localhost:8787' } },
});
