import { PALETTE, WIDTH, HEIGHT, encodePacket, decodePacket } from './packet.mjs';
import type { Design } from './types';
import qrcode from 'qrcode-generator';
export const defaults: Design = { text: 'Something worth\nkeeping.', color: 'black', background: 'white', font_size: 64, align: 'center', font: 'sans', template: 'center', kind: 'text' };
const families = { sans: 'Arial, sans-serif', serif: 'Georgia, serif', mono: '"Courier New", monospace' };
export function renderDesign(canvas: HTMLCanvasElement, design: Design, image?: CanvasImageSource | null, images: Record<string, CanvasImageSource> = {}) {
  canvas.width = WIDTH; canvas.height = HEIGHT;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = PALETTE[design.background]; ctx.fillRect(0, 0, WIDTH, HEIGHT);
  if (design.kind === 'image' && image) {
    const img = image as HTMLImageElement;
    const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
    const scale = Math.min(WIDTH / iw, HEIGHT / ih);
    ctx.drawImage(image, (WIDTH - iw * scale) / 2, (HEIGHT - ih * scale) / 2, iw * scale, ih * scale);
  }
  let overflow = false;
  if (design.kind === 'layout') {
    for (const layer of design.elements || []) {
      ctx.save(); ctx.beginPath(); ctx.rect(layer.x, layer.y, layer.w, layer.h); ctx.clip();
      ctx.fillStyle = PALETTE[layer.color];
      if (layer.type === 'rect') ctx.fillRect(layer.x, layer.y, layer.w, layer.h);
      if (layer.type === 'text') {
        const size = layer.font_size || 32;
        ctx.font = `600 ${size}px ${families[layer.font || 'sans']}`; ctx.textBaseline = 'top'; ctx.textAlign = layer.align || 'left';
        const x = layer.align === 'center' ? layer.x + layer.w / 2 : layer.align === 'right' ? layer.x + layer.w : layer.x;
        const lines: string[] = [];
        for (const paragraph of (layer.text || '').split('\n')) {
          let line = '';
          for (const word of paragraph.split(' ')) {
            const next = line ? line + ' ' + word : word;
            if (line && ctx.measureText(next).width > layer.w) { lines.push(line); line = word; } else line = next;
            if (ctx.measureText(word).width > layer.w) overflow = true;
          }
          lines.push(line);
        }
        overflow ||= lines.length * size * 1.2 > layer.h;
        lines.forEach((line, i) => ctx.fillText(line, x, layer.y + i * size * 1.2));
      }
      if (layer.type === 'qr' && layer.text) {
        try {
          const qr = qrcode(0, 'M'); qr.addData(layer.text); qr.make();
          const modules = qr.getModuleCount(), scale = Math.floor(Math.min(layer.w, layer.h) / (modules + 8));
          if (scale < 2) overflow = true;
          const side = (modules + 8) * scale, x = layer.x + Math.floor((layer.w - side) / 2), y = layer.y + Math.floor((layer.h - side) / 2);
          ctx.fillStyle = '#fff'; ctx.fillRect(layer.x, layer.y, layer.w, layer.h); ctx.fillStyle = '#000';
          for (let row = 0; row < modules; row++) for (let col = 0; col < modules; col++) if (qr.isDark(row, col)) ctx.fillRect(x + (col + 4) * scale, y + (row + 4) * scale, scale, scale);
        } catch { overflow = true; }
      }
      if (layer.type === 'image' && images[layer.id]) {
        const source = images[layer.id], crop = layer.source_rect;
        if (crop?.length === 4) ctx.drawImage(source, crop[0], crop[1], crop[2], crop[3], layer.x, layer.y, layer.w, layer.h);
        else ctx.drawImage(source, layer.x, layer.y, layer.w, layer.h);
      }
      ctx.restore();
    }
  }
  if (design.kind === 'text') {
    ctx.font = `600 ${design.font_size}px ${families[design.font]}`;
    const lines: string[] = [];
    for (const paragraph of design.text.split('\n')) {
      let line = '';
      for (const word of paragraph.split(' ')) {
        const next = line ? `${line} ${word}` : word;
        if (ctx.measureText(next).width > WIDTH - 80 && line) { lines.push(line); line = word; } else line = next;
        if (ctx.measureText(word).width > WIDTH - 80) overflow = true;
      }
      lines.push(line);
    }
    const lineHeight = design.font_size * 1.2;
    overflow ||= lines.length * lineHeight > HEIGHT - 64;
    ctx.fillStyle = PALETTE[design.color]; ctx.textAlign = design.align; ctx.textBaseline = 'middle';
    const x = design.align === 'center' ? WIDTH / 2 : design.align === 'left' ? 40 : WIDTH - 40;
    const start = design.template === 'notice' ? 65 : (HEIGHT - lines.length * lineHeight) / 2 + lineHeight / 2;
    if (design.template === 'notice') { ctx.fillRect(40, 28, 50, 5); }
    lines.forEach((line, index) => ctx.fillText(line, x, start + index * lineHeight));
  }
  // Send a white accent plane even for black-only artwork, so replacing an
  // earlier yellow screen explicitly clears every pigment plane.
  const packet = encodePacket(ctx.getImageData(0, 0, WIDTH, HEIGHT).data, WIDTH, HEIGHT, true);
  ctx.putImageData(new ImageData(decodePacket(packet), WIDTH, HEIGHT), 0, 0);
  return { packet, overflow };
}
