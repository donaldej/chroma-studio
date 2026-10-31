// Explicit live-hardware smoke test: saves two screens and sends Hello Studio.
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const base = process.env.CHROMA_CONTROLLER || 'http://chroma.local';
const serial = process.env.CHROMA_SERIAL;
assert.ok(serial, 'Set CHROMA_SERIAL to the paired display serial; this test sends a real image.');
await mkdir('test-results', { recursive: true });
const browser = await chromium.launch({ ...(process.env.CHROMA_BROWSER_PATH ? { executablePath: process.env.CHROMA_BROWSER_PATH } : {}), headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);
  await page.getByRole('button', { name: 'Saved screens', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Saved screens', exact: true }).click();
  const before = await (await page.request.get(base + '/api/v1/state')).json();
  if (before.presets.some(item => item.name === 'Hello Studio')) {
    await page.getByRole('button', { name: 'Edit Hello Studio', exact: true }).click();
  } else await page.getByRole('button', { name: 'Create a screen', exact: true }).click();
  await page.getByLabel('Screen name', { exact: true }).fill('Hello Studio');
  await page.getByLabel('Message', { exact: true }).fill('Hello, Studio!\nReady when you are.');
  await page.getByRole('button', { name: 'Text color: black', exact: true }).click();
  await page.getByRole('button', { name: 'Paper color: white', exact: true }).click();
  await page.getByRole('button', { name: 'Save screen', exact: true }).click();
  await page.getByRole('heading', { name: 'Hello Studio', exact: true }).waitFor();
  if (!before.presets.some(item => item.name === 'Welcome home')) {
  const add = page.getByRole('button', { name: 'Create a screen', exact: true });
  await add.click();
  await page.getByLabel('Screen name', { exact: true }).fill('Welcome home');
  await page.getByLabel('Message', { exact: true }).fill('Welcome home.');
  await page.getByRole('button', { name: 'Text color: yellow', exact: true }).click();
  await page.getByRole('button', { name: 'Save screen', exact: true }).click();
  await page.getByRole('heading', { name: 'Welcome home', exact: true }).waitFor();
  }
  await page.waitForFunction(() => [...document.querySelectorAll('.preset-preview-button canvas')].every(canvas =>
    canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data.some(value => value !== 255)));
  await page.screenshot({ path: 'test-results/hardware-library.png', fullPage: true });
  const state = await (await page.request.get(base + '/api/v1/state')).json();
  assert.ok(state.presets.some(item => item.name === 'Hello Studio'));
  assert.ok(state.presets.some(item => item.name === 'Welcome home'));
  assert.equal(state.presets.find(item => item.name === 'Hello Studio').text, 'Hello, Studio!\nReady when you are.');
  for (const preset of state.presets.filter(item => ['Hello Studio','Welcome home'].includes(item.name))) {
    const response = await page.request.get(base + '/api/v1/assets/' + preset.asset);
    assert.equal(response.status(), 200);
    const bytes = await response.body();
    assert.equal(bytes.length, 61479);
    assert.equal(bytes[26], 0x21);
    if (preset.name === 'Hello Studio') assert.ok(bytes.subarray(32 + 30720,32 + 61440).every(value => value === 255));
  }
  const invalid = await page.request.post(base + '/api/v1/presets', { data: { id: '../bad', name: 'Bad', asset: 'missing' } });
  assert.equal(invalid.status(), 400);
  const preset = state.presets.find(item => item.name === 'Hello Studio');
  const queued = await page.request.post(base + '/api/v1/jobs', { data: { serial, preset: preset.id } });
  assert.equal(queued.status(), 202);
  const job = await queued.json();
  await writeFile('test-results/hardware-job.json', JSON.stringify(job));
  await page.getByRole('button', { name: 'Activity', exact: true }).click();
  const deadline = Date.now() + 300000, startedAt = Date.now();
  let complete = false, last = '', finalState;
  while (Date.now() < deadline) {
    await page.waitForTimeout(2000);
    finalState = await (await page.request.get(base + '/api/v1/state')).json();
    const current = finalState.jobs.find(item => item.id === job.id);
    if (!current) continue;
    const status = `${current.state}: ${current.progress}%`;
    if (status !== last) { console.log(status); last = status; }
    assert.notEqual(current.state, 'failed', current.error);
    if (current.state === 'completed') { complete = true; break; }
  }
  assert.ok(complete, 'Display must acknowledge the transfer');
  assert.equal(finalState.controller.radio_service, false);
  assert.equal(finalState.controller.direct_radio, true);
  assert.ok(finalState.controller.uptime_ms >= state.controller.uptime_ms + Date.now() - startedAt - 3000, 'Normal send must not restart the controller');
  await writeFile('test-results/hardware-final-state.json', JSON.stringify(finalState,null,2));
  await page.getByText('Acknowledged', { exact: true }).waitFor();
  await page.screenshot({ path: 'test-results/hardware-activity.png', fullPage: true });
  assert.deepEqual(errors, []);
  console.log('PASS: controller-hosted React, full-frame black/yellow assets, library persistence, invalid-input rejection, real display acknowledgement, no controller restart, no browser errors.');
} finally { await browser.close(); }
