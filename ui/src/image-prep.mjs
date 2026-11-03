export const imageDefaults={rotation:0,fit:'contain',crop:{x:0,y:0,w:100,h:100},brightness:0,contrast:1,palette:'color',dither:'none'};
const colors=[[255,255,255],[23,27,25],[230,187,57]];
export function quantizeImage(input,width,height,options={}){
 if(width<1||height<1||input.length!==width*height*4)throw new Error('Invalid image dimensions');
 const settings={...imageDefaults,...options},work=new Float32Array(input),output=new Uint8ClampedArray(input.length),neutralPixels=new Uint8Array(width*height);
 const clamp=value=>Math.max(0,Math.min(255,value));
 for(let i=0;i<work.length;i+=4){
  const alpha=input[i+3]/255;
  for(let c=0;c<3;c++)work[i+c]=clamp(((input[i+c]*alpha+255*(1-alpha))-128)*settings.contrast+128+settings.brightness*2.55);
  if(settings.palette==='mono'){const gray=.2126*work[i]+.7152*work[i+1]+.0722*work[i+2];work[i]=work[i+1]=work[i+2]=gray;}
  neutralPixels[i/4]=Math.max(work[i],work[i+1],work[i+2])-Math.min(work[i],work[i+1],work[i+2])<24?1:0;
 }
 const bayer=[0,8,2,10,12,4,14,6,3,11,1,9,15,7,13,5];
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){
  const i=(y*width+x)*4,offset=settings.dither==='ordered'?(bayer[(y%4)*4+x%4]/16-.5)*96:0;
  const rgb=[clamp(work[i]+offset),clamp(work[i+1]+offset),clamp(work[i+2]+offset)];
  const neutral=settings.palette==='mono'||neutralPixels[y*width+x];
  let best=0,distance=Infinity;
  for(let p=0;p<(neutral?2:3);p++){const d=rgb.reduce((sum,value,c)=>sum+(value-colors[p][c])**2,0);if(d<distance){best=p;distance=d;}}
  for(let c=0;c<3;c++)output[i+c]=colors[best][c];output[i+3]=255;
  if(settings.dither==='floyd')for(const [dx,dy,weight] of [[1,0,7/16],[-1,1,3/16],[0,1,5/16],[1,1,1/16]]){
   if(x+dx<0||x+dx>=width||y+dy>=height)continue;
   const next=((y+dy)*width+x+dx)*4;
   for(let c=0;c<3;c++)work[next+c]+=(rgb[c]-colors[best][c])*weight;
  }
 }
 return output;
}
export function prepareImage(source,options,width=640,height=384){
 const settings={...imageDefaults,...options,crop:{...imageDefaults.crop,...options?.crop}};
 const iw=source.naturalWidth||source.width,ih=source.naturalHeight||source.height;
 if(!iw||!ih||!Number.isFinite(width)||!Number.isFinite(height)||width<1||height<1)throw new Error('Image has no usable dimensions');
 const rotated=document.createElement('canvas'),swap=settings.rotation%180!==0;
 // Limit intermediate memory while keeping enough detail for the e-ink panel.
 const ratio=Math.min(1,2048/Math.max(iw,ih)),rw=Math.max(1,Math.round(iw*ratio)),rh=Math.max(1,Math.round(ih*ratio));
 rotated.width=swap?rh:rw;rotated.height=swap?rw:rh;
 const rc=rotated.getContext('2d');rc.translate(rotated.width/2,rotated.height/2);rc.rotate(settings.rotation*Math.PI/180);rc.drawImage(source,-rw/2,-rh/2,rw,rh);
 const {x,y,w,h}=settings.crop;
 if(![x,y,w,h].every(Number.isFinite)||x<0||y<0||w<1||h<1||x+w>100.001||y+h>100.001)throw new Error('Keep the crop inside the image');
 const crop=[x*rotated.width/100,y*rotated.height/100,w*rotated.width/100,h*rotated.height/100];
 const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
 const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,width,height);
 const scale=(settings.fit==='cover'?Math.max:Math.min)(width/crop[2],height/crop[3]),dw=crop[2]*scale,dh=crop[3]*scale;
 ctx.drawImage(rotated,...crop,(width-dw)/2,(height-dh)/2,dw,dh);
 ctx.putImageData(new ImageData(quantizeImage(ctx.getImageData(0,0,width,height).data,width,height,settings),width,height),0,0);
 return {canvas,source:rotated};
}
