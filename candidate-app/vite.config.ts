import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development the UI talks to the API through /api. The desktop shell
// will point the same client at the organisation's API endpoint instead.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.EXAMGUARD_API ?? 'http://localhost:3000',
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
});
