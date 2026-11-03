import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { decodePacket } from './packet.mjs';
export const digest = bytes => bytesToHex(sha256(bytes));
export function referencedAssets(config) {
  return [...new Set((config.presets || []).flatMap(preset => [preset.asset, ...(preset.elements || []).filter(layer => layer.type === 'image').map(layer => layer.asset)]).concat((config.history || []).map(entry => entry.asset), (config.devices || []).map(device=>device.last_asset).filter(Boolean)))];
}
export function validateBackup(bundle) {
  if (bundle?.format !== 'chroma-studio/1' || !bundle.config || !bundle.assets ||
      !Array.isArray(bundle.config.devices) || !Array.isArray(bundle.config.presets)) throw new Error('Choose a full Chroma Studio backup.');
  const config = bundle.config;
  if (config.devices.length > 12 || config.presets.length > 20 || (config.automations || []).length > 12) throw new Error('This backup exceeds the controller limits.');
  if ((config.history || []).length > 16) throw new Error('Too many history entries.');
  for (const entry of config.history || []) if (!/^[A-Za-z0-9_-]{1,32}$/.test(entry.id) || !config.devices.some(device=>device.serial===entry.serial) || typeof entry.title!=='string' || entry.title.length>48) throw new Error('Invalid image history entry.');
  const packets = new Map();
  for (const asset of referencedAssets(config)) {
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(asset) || !bundle.assets[asset]) throw new Error('Missing or invalid image asset.');
    const entry = bundle.assets[asset];
    if (typeof entry.data !== 'string' || entry.data.length > 90000) throw new Error('Invalid image asset.');
    const bytes = Uint8Array.from(atob(entry.data), char => char.charCodeAt(0));
    if (digest(bytes) !== entry.sha256) throw new Error('Backup checksum mismatch: ' + asset);
    decodePacket(bytes);
    const payload = bytes.subarray(32, -7);
    if ((payload.reduce((sum, value) => sum + value, 0) + bytes[22]) % 256 !== 0) throw new Error('Image command checksum mismatch.');
    packets.set(asset, bytes);
  }
  if (new Set(config.devices.map(device => device.serial)).size !== config.devices.length || new Set(config.presets.map(preset => preset.id)).size !== config.presets.length) throw new Error('Duplicate entries in backup.');
  for (const device of config.devices) if (!/^[A-Z]{2}\d{8}[BC]$/.test(device.serial) || !device.name) throw new Error('Invalid display in backup.');
  for (const preset of config.presets) if (!/^[A-Za-z0-9_-]{1,32}$/.test(preset.id) || !preset.name) throw new Error('Invalid saved screen in backup.');
  return { config, packets };
}
