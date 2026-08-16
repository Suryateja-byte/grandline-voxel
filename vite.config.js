import { defineConfig } from 'vite';
export default defineConfig({
  server: { port: 5273, strictPort: true, host: '127.0.0.1' },
  preview: { port: 5274, strictPort: true, host: '127.0.0.1' },
  build: { target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 2000 },
});
