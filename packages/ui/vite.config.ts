import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The daemon serves this build at /ui same-origin (design D2), so the base path
// is `/ui/` and API calls use relative `/api/...` URLs (no CORS, no host config).
export default defineConfig({
  base: '/ui/',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
