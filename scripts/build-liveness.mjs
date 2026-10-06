// Builds the AWS Face Liveness widget (liveness-widget/) into one script and one stylesheet in
// liveness-dist/, served by the service at /verify/liveness-widget.js and .css.
// Usage: node scripts/build-liveness.mjs [outdir]
import { build } from 'esbuild';
import { resolve } from 'path';

const outdir = resolve(process.argv[2] ?? 'liveness-dist');
await build({
  entryPoints: { 'liveness-widget': 'liveness-widget/index.tsx' },
  outdir,
  bundle: true,
  minify: true,
  format: 'iife',
  target: ['es2020'],
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"', global: 'window' },
  loader: { '.svg': 'dataurl', '.png': 'dataurl' },
  legalComments: 'none',
  logLevel: 'warning',
});
console.log(`Liveness widget built in ${outdir}`);
