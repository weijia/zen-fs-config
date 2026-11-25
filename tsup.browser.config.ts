import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { 'zen-fs-config': 'src/index.ts' },
  format: ['iife'],
  globalName: 'ZenFSConfig',
  platform: 'browser',
  target: 'es2020',
  noExternal: [/.*/],
  splitting: false,
  clean: false,
  outExtension: () => ({ js: '.js' }),
  define: { 'process.env.NODE_ENV': '"production"' },
});
