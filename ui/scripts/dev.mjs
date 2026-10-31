import { context } from 'esbuild';
import { createServer, request as httpRequest } from 'node:http';
import { readFile } from 'node:fs/promises';
const ctx = await context({ entryPoints: ['src/main.tsx'], outfile: 'dist/app.js', bundle: true,
  sourcemap: true, target: ['es2020'], define: { 'process.env.NODE_ENV': '"development"' } });
await ctx.rebuild(); await ctx.watch();
const controller = new URL(process.env.CHROMA_CONTROLLER || 'http://chroma.local');
createServer(async (req, res) => {
  if (req.url.startsWith('/api/') || req.url.startsWith('/wifi')) {
    const proxy = httpRequest(new URL(req.url, controller), { method: req.method, headers: { ...req.headers, host: controller.host } }, upstream => {
      res.writeHead(upstream.statusCode, upstream.headers); upstream.pipe(res);
    });
    proxy.on('error', () => { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end('{"error":"Controller is unreachable"}'); });
    req.pipe(proxy); return;
  }
  try {
    const file = req.url === '/' ? 'index.html' : 'dist/' + req.url.split('?')[0].split('/').pop();
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'text/html', 'Cache-Control': 'no-store' });
    res.end(data);
  } catch { res.writeHead(404); res.end('Not found'); }
}).listen(5173, '127.0.0.1', () => console.log('Chroma Studio: http://127.0.0.1:5173'));
