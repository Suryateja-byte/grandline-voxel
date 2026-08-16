import { defineConfig } from 'vite';

// GLV_NO_WATCH: set by the evidence harness (tools/lib.mjs startServer). A measurement
// server must never hot-reload: vite's watcher reacts to Windows file-event noise with
// full page reloads, which navigated the page MID-PLAYTEST and destroyed three runs
// ("Execution context was destroyed" ~17 s in — the vite log showed `page reload
// src/game.js` with no file actually edited). `npm run dev` keeps HMR for humans.
const harness = !!process.env.GLV_NO_WATCH;

export default defineConfig({
  server: {
    port: 5273, strictPort: true, host: '127.0.0.1',
    ...(harness ? { watch: null, hmr: false } : {}),
  },
  preview: { port: 5274, strictPort: true, host: '127.0.0.1' },
  build: { target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 2000 },
});
