import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API_PORT = process.env.PORT || 5178;

export default defineConfig({
  root: 'client',
  plugins: [react()],
  build: {
    outDir: '../public',
    emptyOutDir: true,
  },
  server: {
    port: 5179,
    proxy: {
      '/api': `http://127.0.0.1:${API_PORT}`,
    },
  },
});
