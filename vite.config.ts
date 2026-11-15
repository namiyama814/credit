import { defineConfig } from 'vite';
import { cloudflare } from '@cloudflare/vite-plugin';
export default defineConfig({
  publicDir: 'dist/web',
  plugins: [cloudflare({ inspectorPort: false, remoteBindings: process.env.AI_REMOTE === 'true', persistState: { path: process.env.VITE_TEST_STATE ?? '.cloudflare/state' } })],
  server: { host: '127.0.0.1', port: Number(process.env.APP_TEST_PORT) || 4321, strictPort: true },
  build: { emptyOutDir: true, outDir: 'dist/worker' },
});
