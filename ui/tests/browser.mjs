import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { encodePacket } from '../src/packet.mjs';

await mkdir('test-results', { recursive: true });
const fixture = { revision: 1, controller: { name: 'Chroma Studio', version: '0.2.0', ip: '192.0.2.10', connected: true, uptime_ms: 5000,
  heap_free: 150000, storage_used: 400000, storage_total: 3538944, radio_mode: 'Idle', channel: 0, network_id: 1 },
  devices: [{ serial: 'JM00000000B', name: 'My Chroma74', id: 123, palette: 'bwy', channel: 0, network: 1, wake_channel: 4 }], presets: [], jobs: [] };
const assets = new Map();
const server = createServer(async (req, res) => {
  try { const file = req.url === '/' ? 'dist/index.htm' : 'dist/' + req.url.split('?')[0].split('/').pop();
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
    res.end(await readFile(file));
  } catch { res.statusCode = 404; res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ ...(process.env.CHROMA_BROWSER_PATH ? { executablePath: process.env.CHROMA_BROWSER_PATH } : {}), headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const respond = data => route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
    if (path === '/api/v1/state') return respond(fixture);
    if (path === '/api/v1/assets' && request.method() === 'POST') {
      const body = request.postDataBuffer();
      const name = body.toString('latin1').match(/filename="([^"]+)"/)[1].replace('.bin', '');
      const offset = body.indexOf(Buffer.from([0x83, 0x19, 0]));
      assert.ok(offset > 0);
      const length = body.readUInt16LE(offset + 7) + 39;
      const command = body.subarray(offset, offset + length);
      assert.equal(command[26], 0x21, 'yellow text should upload two planes');
      assets.set(name, command);
      return respond({ asset: name, bytes: length });
    }
    if (path.startsWith('/api/v1/assets/')) return route.fulfill({ contentType: 'application/octet-stream', body: assets.get(path.split('/').pop()) });
    const body = request.postDataJSON();
    if (path === '/api/v1/presets') { fixture.presets.push(body); return respond({ accepted: true, id: 'save-test' }); }
    if (path === '/api/v1/jobs') {
      assert.ok(fixture.presets.some(preset => preset.id === body.preset));
      fixture.jobs.push({ id: 'job-test', serial: body.serial, preset: body.preset, title: 'Integration test', state: 'queued', progress: 0, remaining: 61479, total: 61479, kind: 'send', error: '' });
      return respond({ accepted: true, id: 'job-test' });
    }
    if (path === '/api/v1/jobs/cancel') { fixture.jobs[0].state = 'cancelled'; return respond({ accepted: true, id: 'cancel-test' }); }
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"Not found"}' });
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  await page.goto(url);
  await page.getByRole('heading', { name: 'My Chroma74' }).waitFor();
  await page.screenshot({ path: 'test-results/displays-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'Saved screens', exact: true }).click();
  await page.getByRole('button', { name: 'Create your first screen' }).click();
  await page.getByLabel('Screen name', { exact: true }).fill('Integration test');
  await page.getByLabel('Message', { exact: true }).fill('Hello from Studio');
  await page.getByRole('button', { name: 'Text color: yellow', exact: true }).click();
  await page.screenshot({ path: 'test-results/editor-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'Save & send' }).click();
  await page.getByRole('heading', { name: 'Every update, in view.' }).waitFor();
  await page.getByText('Integration test', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Cancel Integration test' }).click();
  await page.getByText('Cancelled', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByText('Turn the wheel', { exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Displays', exact: true }).click();
  await page.screenshot({ path: 'test-results/displays-mobile.png', fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'mobile layout must not scroll horizontally');
  assert.deepEqual(errors, []);
  console.log('PASS: editor → two-plane upload → save → queued send → cancellation; desktop/mobile layouts; no browser errors.');
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
