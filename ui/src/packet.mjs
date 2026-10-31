export const WIDTH = 640, HEIGHT = 384;
export const PALETTE = { white: '#ffffff', black: '#171b19', yellow: '#e6bb39' };

export function encodePacket(rgba, width = WIDTH, height = HEIGHT, forceAccent = false) {
  if (width !== WIDTH || height !== HEIGHT || rgba.length !== width * height * 4) throw new Error('Expected a 640 × 384 image.');
  const black = new Uint8Array(width * height / 8).fill(255);
  const yellow = new Uint8Array(black.length).fill(255);
  let hasYellow = false;
  for (let pixel = 0; pixel < width * height; pixel++) {
    const offset = pixel * 4, r = rgba[offset], g = rgba[offset + 1], b = rgba[offset + 2];
    let dr = r - 255, dg = g - 255, db = b - 255;
    let best = 0, distance = dr * dr + dg * dg + db * db;
    dr = r - 23; dg = g - 27; db = b - 25;
    const blackDistance = dr * dr + dg * dg + db * db;
    if (blackDistance < distance) { best = 1; distance = blackDistance; }
    // Keep gray antialiasing pixels neutral instead of introducing yellow
    // fringes around otherwise black text.
    if (Math.max(r, g, b) - Math.min(r, g, b) >= 24) {
      dr = r - 230; dg = g - 187; db = b - 57;
      if (dr * dr + dg * dg + db * db < distance) best = 2;
    }
    if (best === 1) black[pixel >> 3] &= ~(128 >> (pixel & 7));
    if (best === 2) { yellow[pixel >> 3] &= ~(128 >> (pixel & 7)); hasYellow = true; }
  }
  hasYellow ||= forceAccent;
  const payload = new Uint8Array(black.length * (hasYellow ? 2 : 1));
  payload.set(black); if (hasYellow) payload.set(yellow, black.length);
  const packet = new Uint8Array(payload.length + 39), view = new DataView(packet.buffer);
  packet.set([0x83, 0x19], 0);
  view.setUint16(3, width, true); view.setUint16(5, height, true);
  view.setUint16(7, payload.length, true);
  packet[22] = (-payload.reduce((sum, value) => sum + value, 0)) & 255;
  packet[26] = hasYellow ? 0x21 : 0;
  packet.set([0x84, 0x80, 0], 27); view.setUint16(30, payload.length, false);
  packet.set(payload, 32); packet.set([0x85, 5, 8, 0, 0, 1, 1], 32 + payload.length);
  return packet;
}

export function decodePacket(packet) {
  if (!(packet instanceof Uint8Array)) packet = new Uint8Array(packet);
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  if (packet.length < 39 || packet[0] !== 0x83 || packet[23] !== 0 || view.getUint16(3, true) !== WIDTH || view.getUint16(5, true) !== HEIGHT) throw new Error('Preview is unavailable for this screen format.');
  const planeSize = WIDTH * HEIGHT / 8, hasYellow = packet[26] === 0x21;
  if (packet.length !== planeSize * (hasYellow ? 2 : 1) + 39) throw new Error('Incomplete screen image.');
  const rgba = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
  const colors = [[255, 255, 255], [23, 27, 25], [230, 187, 57]];
  for (let pixel = 0; pixel < WIDTH * HEIGHT; pixel++) {
    const mask = 128 >> (pixel & 7), offset = pixel >> 3;
    const black = !(packet[32 + offset] & mask);
    const yellow = hasYellow && !(packet[32 + planeSize + offset] & mask);
    const color = colors[yellow ? 2 : black ? 1 : 0], target = pixel * 4;
    rgba[target] = color[0]; rgba[target + 1] = color[1]; rgba[target + 2] = color[2]; rgba[target + 3] = 255;
  }
  return rgba;
}
