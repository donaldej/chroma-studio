import { PALETTE, WIDTH, HEIGHT, encodePacket, decodePacket } from './packet.mjs';
import type { Design } from './types';
export const defaults: Design = { text: 'Something worth\nkeeping.', color: 'black', background: 'white', font_size: 64, align: 'center', font: 'sans', template: 'center', kind: 'text' };
const families = { sans: 'Arial, sans-serif', serif: 'Georgia, serif', mono: '"Courier New", monospace' };
export function renderDesign(canvas: HTMLCanvasElement, design: Design, image?: CanvasImageSource | null) {
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
  if (design.kind !== 'image') {
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
