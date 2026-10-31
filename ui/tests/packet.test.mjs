import test from 'node:test';
import assert from 'node:assert/strict';
import { encodePacket, decodePacket, WIDTH, HEIGHT } from '../src/packet.mjs';

test('stock command framing and checksum for a black pixel on white', () => {
  const rgba = new Uint8ClampedArray(WIDTH * HEIGHT * 4).fill(255);
  rgba.set([23, 27, 25, 255], 0);
  const packet = encodePacket(rgba);
  assert.equal(packet.length, 30759);
  assert.deepEqual([...packet.slice(0, 9)], [0x83, 0x19, 0, 0x80, 2, 0x80, 1, 0, 0x78]);
  assert.equal(packet[22], 128);
  assert.equal(packet[26], 0);
  assert.equal(packet[32], 0x7f);
  assert.deepEqual([...packet.slice(-7)], [0x85, 5, 8, 0, 0, 1, 1]);
  assert.deepEqual([...decodePacket(packet).slice(0, 8)], [23, 27, 25, 255, 255, 255, 255, 255]);
});

test('yellow uses a separate plane without marking black at the same pixel', () => {
  const rgba = new Uint8ClampedArray(WIDTH * HEIGHT * 4).fill(255);
  const pixel = WIDTH * 32 + 19;
  rgba.set([230, 187, 57, 255], pixel * 4);
  const packet = encodePacket(rgba);
  assert.equal(packet.length, 61479);
  assert.equal(packet[26], 0x21);
  assert.equal(packet[32 + (pixel >> 3)], 255);
  assert.equal(packet[32 + 30720 + (pixel >> 3)], 0xef);
  assert.deepEqual([...decodePacket(packet).slice(pixel * 4, pixel * 4 + 4)], [230, 187, 57, 255]);
});

test('gray antialiasing remains monochrome without yellow fringes', () => {
  const rgba = new Uint8ClampedArray(WIDTH * HEIGHT * 4).fill(255);
  for (let gray = 0; gray < 256; gray++) rgba.set([gray, gray, gray, 255], gray * 4);
  assert.equal(encodePacket(rgba).length, 30759);
});

test('full-frame monochrome artwork explicitly clears the accent plane', () => {
  const rgba = new Uint8ClampedArray(WIDTH * HEIGHT * 4).fill(255);
  rgba.set([23, 27, 25, 255], 0);
  const packet = encodePacket(rgba, WIDTH, HEIGHT, true);
  assert.equal(packet.length, 61479);
  assert.equal(packet[26], 0x21);
  assert.ok(packet.slice(32 + 30720, 32 + 61440).every(value => value === 255));
  assert.deepEqual([...decodePacket(packet).slice(0, 4)], [23, 27, 25, 255]);
});

test('malformed dimensions, compressed previews and truncated files are rejected', () => {
  assert.throws(() => encodePacket(new Uint8Array(3)));
  const packet = encodePacket(new Uint8ClampedArray(WIDTH * HEIGHT * 4).fill(255));
  assert.throws(() => decodePacket(packet.slice(0, -1)));
  packet[23] = 2;
  assert.throws(() => decodePacket(packet));
});
