import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const proxy = {
  '/api': {
    target: process.env.SUZUBASE_API_ORIGIN ?? 'http://127.0.0.1:3000',
    rewrite: (path: string) => path.replace(/^\/api(?=\/|$)/, ''),
  },
};
export default defineConfig({
  resolve: { alias: { '@suzubase/shared-types': fileURLToPath(new URL('../../packages/shared-types/src/index.ts', import.meta.url)) } },
  server: { proxy },
  preview: { proxy },
});
