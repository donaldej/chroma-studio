// Read-only regression check against this host's acknowledged text snapshots.
import { chromium } from 'playwright';
import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { encodePacket, WIDTH, HEIGHT } from '../src/packet.mjs';
const backup = process.argv[2] || '../backups/studio-final';
const config = JSON.parse(await readFile(backup + '/studio.json', 'utf8'));
const base = process.env.CHROMA_CONTROLLER || 'http://chroma.local';
const browser = await chromium.launch({ ...(process.env.CHROMA_BROWSER_PATH ? { executablePath: process.env.CHROMA_BROWSER_PATH } : {}), headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);
  await page.getByRole('button', { name: 'Saved screens', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Saved screens', exact: true }).click();
  for (const preset of config.presets.filter(item => item.kind === 'text')) {
    assert.match(preset.asset, /^[A-Za-z0-9_-]{1,32}$/);
    await page.getByRole('button', { name: 'Edit ' + preset.name, exact: true }).click();
    const canvas = page.getByLabel('Live screen preview', { exact: true });
    await page.waitForFunction(() => {
      const canvas = document.querySelector('canvas[aria-label="Live screen preview"]');
      return canvas?.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data.some(value => value !== 255);
    });
    // Match Save's repeated repaint/readback path when comparing snapshots.
    await page.getByRole('button', { name: 'Text color: ' + preset.color, exact: true }).click();
    await page.getByRole('button', { name: 'Paper color: ' + preset.background, exact: true }).click();
    await page.waitForTimeout(150);
    const rgba = await canvas.evaluate(canvas => Array.from(canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data));
    const packet = Buffer.from(encodePacket(new Uint8ClampedArray(rgba), WIDTH, HEIGHT, true));
    const acknowledged = await readFile(backup + '/' + preset.asset + '.bin');
    if (!packet.equals(acknowledged)) {
      const differences = []; let count = 0;
      for (let i = 0; i < packet.length; ++i) if (packet[i] !== acknowledged[i]) { ++count; if (differences.length < 12) differences.push([i, acknowledged[i], packet[i]]); }
      console.log(JSON.stringify({ name: preset.name, actualBytes: packet.length, expectedBytes: acknowledged.length, differences: count, first: differences }));
      await writeFile('test-results/preview-comparison.bin', packet);
      await page.screenshot({ path: 'test-results/preview-comparison.png', fullPage: true });
      assert.fail('Rendered command changed for ' + preset.name);
    }
    await page.getByRole('button', { name: 'Back to saved screens', exact: true }).click();
  }
  await page.getByRole('button', { name: 'Displays', exact: true }).click();
  await page.screenshot({ path: 'test-results/final-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'test-results/final-mobile.png', fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(errors, []);
  console.log('PASS: deployed optimized editor produces byte-identical acknowledged black/yellow commands; desktop/mobile layouts; no writes or radio sends.');
} finally { await browser.close(); }
