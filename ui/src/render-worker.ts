import { renderDesign } from './render';
import { decodePacket, WIDTH, HEIGHT } from './packet.mjs';
import type { Design } from './types';
declare global { interface Window { renderStudioFrame: (design: Design, assets: Record<string,string>) => number[] } }
window.renderStudioFrame = (design, assets) => {
  const images: Record<string,CanvasImageSource> = {};
  for (const layer of design.elements || []) if (layer.type === 'image' && layer.asset && assets[layer.asset]) {
    const bytes = Uint8Array.from(atob(assets[layer.asset]),char=>char.charCodeAt(0));
    const canvas=document.createElement('canvas'); canvas.width=WIDTH;canvas.height=HEIGHT;
    canvas.getContext('2d')!.putImageData(new ImageData(decodePacket(bytes),WIDTH,HEIGHT),0,0); images[layer.id]=canvas;
  }
  const result=renderDesign(document.createElement('canvas'),design,null,images);
  if (result.overflow) throw new Error('Live content does not fit the saved template. Reduce its text size or enlarge its layers.');
  return Array.from(result.packet);
};
