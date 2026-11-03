export const uid = () => Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
export async function api(path: string, body?: unknown) {
  const response = await fetch('/api/v1' + path, { method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(12000) });
  const result = await response.json().catch(() => ({ error: 'The controller returned an unexpected response.' }));
  if (!response.ok) throw new Error(result.error || 'The request could not be completed.');
  return result;
}
export async function uploadPacket(packet: Uint8Array, asset = uid()) {
  const body = new FormData(); body.append('data', new Blob([new Uint8Array(packet)], { type: 'application/octet-stream' }), asset + '.bin');
  // Uploads can be rejected transiently by the old async multipart handler;
  // retry once with a new name, never overwrite an existing asset.
  let last = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const name = attempt ? uid() : asset, form = attempt ? new FormData() : body;
    if (attempt) form.append('data', new Blob([new Uint8Array(packet)]), name + '.bin');
    const response = await fetch('/api/v1/assets', { method: 'POST', body: form, signal: AbortSignal.timeout(20000) });
    const result = await response.json();
    if (response.ok) return result.asset as string;
    last = result.error || 'Could not upload the screen.';
    if (response.status !== 400) break;
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw new Error(last);
}
export function download(name: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
