/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: { chunkSizeWarningLimit: 1100 },
  // Même relais qu'en production (nginx.conf) pour les connecteurs de catalogues
  server: {
    proxy: {
      '/connecteurs/apify': { target: 'https://api.apify.com', changeOrigin: true, rewrite: (p) => p.replace(/^\/connecteurs\/apify/, '') },
      '/connecteurs/writ': { target: 'https://api.usewrit.app', changeOrigin: true, rewrite: (p) => p.replace(/^\/connecteurs\/writ/, '') },
      // IA locale : Ollama lancé sur ce poste (ollama serve), ou l'adresse donnée dans OLLAMA_URL
      '/ia-locale': {
        target: process.env.OLLAMA_URL ?? 'http://localhost:11434',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/ia-locale/, ''),
        configure: (proxy) => proxy.on('proxyReq', (req) => req.removeHeader('origin')),
      },
    },
  },
  test: { environment: 'node' },
});
