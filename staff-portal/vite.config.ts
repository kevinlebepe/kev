import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development the portal talks to the API through /api, like the candidate app.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      '/api': {
        target: process.env.EXAMGUARD_API ?? 'http://localhost:3000',
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
});
