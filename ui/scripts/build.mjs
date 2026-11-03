import { build } from 'esbuild';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
await mkdir('dist', { recursive: true });
await build({ entryPoints: ['src/main.tsx'], outfile: 'dist/app.js', bundle: true, minify: true,
  sourcemap: false, target: ['es2020'], define: { 'process.env.NODE_ENV': '"production"' }, legalComments: 'eof' });
await build({ entryPoints: ['src/render-worker.ts'], outfile: 'dist/render-worker.js', bundle: true, minify: true, target: ['es2020'] });
await copyFile('index.html', 'dist/index.htm');
if (process.argv.includes('--deploy')) {
  for (const file of ['app.js', 'app.css']) {
    await writeFile('../firmware/data/' + file + '.gz', gzipSync(await readFile('dist/' + file), { level: 9 }));
  }
  await copyFile('dist/index.htm', '../firmware/data/index.htm');
}
console.log('Chroma Studio production build ready.');
