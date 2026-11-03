import {chromium} from 'playwright';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {sha256} from '@noble/hashes/sha256';
import {bytesToHex} from '@noble/hashes/utils';
import {decodePacket} from '../src/packet.mjs';
const state={revision:1,controller:{name:'Studio',version:'0.5.0',ip:'192.0.2.1',connected:true,radio_mode:'Idle'},devices:[{serial:'JM00000000B',name:'Test tag',id:123,palette:'bwy',channel:0,network:1,wake_channel:4}],presets:[],jobs:[],settings:{brightness:180,screen_timeout:120,max_attempts:2,timezone:'UTC'},automations:[]};
let status={version:'0.5.0',running_slot:'app0',update_slot:'app1',max_bytes:0x640000,rollback_available:false,status:'idle'},uploaded,committed=false;
const server=createServer(async(req,res)=>{try{const file=req.url==='/'?'index.htm':req.url.split('/').pop();res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(await readFile('dist/'+file));}catch{res.statusCode=404;res.end();}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));await mkdir('test-results',{recursive:true});
const browser=await chromium.launch({headless:true,...(process.env.CHROMA_BROWSER_PATH?{executablePath:process.env.CHROMA_BROWSER_PATH}:{})});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1080}}),errors=[];page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>dialog.accept());
 await page.route('**/api/v1/**',async route=>{const req=route.request(),path=new URL(req.url()).pathname,respond=value=>route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
  if(path.endsWith('/state'))return respond(state);
  if(path==='/api/v1/firmware')return respond(status);
  if(path.endsWith('/firmware/upload')){assert.equal(req.headers()['x-chroma-update'],'1');return respond({status:'staged',token:'test-token'});}
  if(path.endsWith('/firmware/commit')){assert.equal(req.postDataJSON().token,'test-token');committed=true;status={...status,running_slot:'app1',rollback_available:true};return respond({status:'restarting'});}
  if(path.endsWith('/firmware/rollback')){status={...status,running_slot:'app0'};return respond({status:'restarting'});}
  if(path==='/api/v1/assets'){const bytes=req.postDataBuffer(),start=bytes.indexOf(Buffer.from([0x83,0x19,0])),size=bytes.readUInt16LE(start+7)+39;uploaded=bytes.subarray(start,start+size);return respond({asset:'prepared'});}
  if(path==='/api/v1/presets'){state.presets.push(req.postDataJSON());return respond({accepted:true});}
  return route.fulfill({status:404,body:'{}'});
 });
 await page.goto('http://127.0.0.1:'+server.address().port);
 await page.getByRole('navigation').getByRole('button',{name:'Saved screens',exact:true}).click();await page.getByRole('button',{name:'Create a screen'}).click();await page.getByRole('button',{name:'Image',exact:true}).click();
 const png=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=100;c.height=50;const x=c.getContext('2d');x.fillStyle='black';x.fillRect(0,0,50,50);x.fillStyle='white';x.fillRect(50,0,50,50);return c.toDataURL('image/png').split(',')[1];});
 await page.locator('.image-upload input[type=file]').setInputFiles({name:'halves.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});
 await page.getByRole('dialog',{name:'Prepare your image.'}).waitFor();await page.getByLabel('Crop w',{exact:true}).fill('50');await page.getByLabel('Image fit').selectOption('cover');await page.getByLabel('Dithering').selectOption('floyd');await page.getByLabel('Image colors').selectOption('mono');
 const pixel=await page.getByLabel('Prepared image preview').evaluate(c=>Array.from(c.getContext('2d').getImageData(500,200,1,1).data));assert(pixel[0]<50,'left-half crop fills output with black');
 await page.getByRole('button',{name:'Rotate right'}).click();await page.getByLabel('Crop h',{exact:true}).fill('50');
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:'test-results/image-preparation-mobile.png',fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await page.getByRole('button',{name:'Use prepared image'}).click();await page.getByLabel('Screen name',{exact:true}).fill('Prepared photo');await page.getByRole('button',{name:'Save screen',exact:true}).click();await page.getByRole('heading',{name:'Prepared photo'}).waitFor();assert(uploaded);const pixels=decodePacket(uploaded);for(let i=0;i<pixels.length;i+=4)assert(pixels[i]===23||pixels[i]===255);
 await page.getByRole('navigation').getByRole('button',{name:'Settings',exact:true}).click();await page.locator('input[accept=".chroma"]').setInputFiles({name:'wrong.chroma',mimeType:'application/octet-stream',buffer:Buffer.from('invalid')});await page.getByRole('alert').filter({hasText:'Choose a Chroma Studio'}).waitFor();
 const app=new Uint8Array(100000);app[0]=0xe9;app[12]=9;app.set(new TextEncoder().encode('CHROMA-STUDIO:T-EMBED-CC1101-PLUS:WEB1:0.5.0\0'),100);const manifest={format:1,board:'lilygo-t-embed-cc1101-plus',embedded_web:true,version:'0.5.0',bytes:app.length,sha256:bytesToHex(sha256(app))},json=Buffer.from(JSON.stringify(manifest)),bytes=Buffer.alloc(12+json.length+app.length);bytes.write('CHROMA5\n');bytes.writeUInt32LE(json.length,8);json.copy(bytes,12);Buffer.from(app).copy(bytes,12+json.length);
 await page.locator('input[accept=".chroma"]').setInputFiles({name:'studio.chroma',mimeType:'application/octet-stream',buffer:bytes});await page.getByRole('button',{name:'Install update',exact:true}).click();await page.getByText('Firmware boot verified. Refresh this page to load the updated interface.',{exact:true}).waitFor();assert(committed);
 await page.getByText('Recovery and previous firmware',{exact:true}).click();await page.getByRole('button',{name:'Use previous firmware',exact:true}).click();await page.getByText('Firmware boot verified. Refresh this page to load the updated interface.',{exact:true}).waitFor();assert.equal(status.running_slot,'app0');
 await page.screenshot({path:'test-results/firmware-updates-mobile.png',fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[]);
 console.log('PASS: crop, rotation, dithering, monochrome saved packet, mobile image controls, bad firmware rejection, upload/commit/boot confirmation and previous-application flow');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
