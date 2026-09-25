import { defineConfig } from 'tsup';

export default defineConfig([
  // Standard npm build: CJS + ESM, peer dependencies kept external
  {
    entry: ['src/index.ts'],
    format: ['cjs', 'esm'],
    dts: true,
    clean: false,
  },
  // Browser IIFE build: bundles ALL dependencies into a single file that
  // can be loaded directly via <script src="..."> in any HTML page.
  // Exposes the library on window.ZenFSConfig.
  {
    entry: ['src/index.ts'],
    format: ['iife'],
    globalName: 'ZenFSConfig',
    platform: 'browser',
    target: 'es2020',
    // Bundle every dependency (including peer deps) into the single file
    noExternal: [/.*/],
    // Avoid splitting so we get exactly one .js file
    splitting: false,
    clean: false,
    outExtension: () => ({ js: '.browser.js' }),
    // Drop Node.js-only references; browser-safe fallbacks exist in code
    define: {
      'process.env.NODE_ENV': '"production"',
    },
  },
]);
