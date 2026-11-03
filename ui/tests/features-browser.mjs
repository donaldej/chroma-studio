import {chromium} from 'playwright';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
import jsQR from 'jsqr';
import {encodePacket,WIDTH,HEIGHT} from '../src/packet.mjs';

await mkdir('test-results',{recursive:true});
const packet=encodePacket(new Uint8ClampedArray(WIDTH*HEIGHT*4).fill(255),WIDTH,HEIGHT,true),assets=new Map([['initial',Buffer.from(packet)]]);
const state={revision:1,controller:{name:'Studio',version:'0.3.0',ip:'192.0.2.10',connected:true,uptime_ms:5000,heap_free:130000,storage_used:400000,storage_total:3245681,radio_mode:'Idle',clock_synced:true,epoch:1793500000},devices:[{serial:'JM00000000B',name:'Test display',id:123,palette:'bwy',channel:0,network:1,wake_channel:4,last_preset:'first',health:{voltage_mv:2987,width:640,height:384,firmware:'3.7.18.0',measured_at:1793500000}}],presets:[{id:'first',name:'First',asset:'initial',kind:'text',text:'Hello',color:'black',background:'white',font_size:40,font:'sans',align:'center',template:'center'}],jobs:[],automations:[],settings:{brightness:180,screen_timeout:120,max_attempts:2,timezone:'America/New_York'}};
const server=createServer(async(req,res)=>{try{const name=req.url==='/'?'index.htm':req.url.split('/').pop();res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html');res.end(await readFile('dist/'+name));}catch{res.statusCode=404;res.end();}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({headless:true,...(process.env.CHROMA_BROWSER_PATH?{executablePath:process.env.CHROMA_BROWSER_PATH}:{})});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1100}}),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',dialog=>dialog.accept());
 await page.route('**/api/v1/**',async route=>{
  const request=route.request(),path=new URL(request.url()).pathname;const respond=value=>route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
  if(path.endsWith('/state'))return respond(state);
  if(path.endsWith('/export'))return respond({devices:state.devices,presets:state.presets,automations:state.automations,settings:state.settings});
  if(path==='/api/v1/assets'){
   const bytes=request.postDataBuffer(),name=bytes.toString('latin1').match(/filename="([^"]+)"/)[1].replace('.bin',''),start=bytes.indexOf(Buffer.from([0x83,0x19,0]));const length=bytes.readUInt16LE(start+7)+39;assets.set(name,bytes.subarray(start,start+length));return respond({asset:name,bytes:length});
  }
  if(path.startsWith('/api/v1/assets/'))return route.fulfill({contentType:'application/octet-stream',body:assets.get(path.split('/').pop())});
  const body=request.postDataJSON();
  const upsert=(list,key)=>{const i=list.findIndex(item=>item[key]===body[key]);if(i<0)list.push(body);else list[i]=body;};
  if(path==='/api/v1/presets')upsert(state.presets,'id');
  else if(path==='/api/v1/displays')upsert(state.devices,'serial');
  else if(path==='/api/v1/automations')upsert(state.automations,'id');
  else if(path==='/api/v1/automations/toggle')state.automations.find(item=>item.id===body.id).enabled=body.enabled;
  else if(path==='/api/v1/settings')Object.assign(state.settings,body);
  else if(path==='/api/v1/displays/confirm')state.devices.find(item=>item.serial===body.serial).visual_confirmed=body.confirmed;
  else if(path==='/api/v1/displays/inspect'){assert.equal(body.query,'panel');state.jobs.push({id:'inspect',serial:body.serial,title:'Read display panel',kind:'inspect',state:'completed',progress:100,total:1,remaining:0,query:'panel',reply:'9A:10:80:01:80:02',error:''});}
  else if(path==='/api/v1/time')state.controller.clock_synced=true;
  else return route.fulfill({status:404,body:'{"error":"Unknown mock route"}'});
  return respond({accepted:true,id:'mock'});
 });
 await page.goto(`http://127.0.0.1:${server.address().port}`);
 await page.getByRole('button',{name:'Saved screens',exact:true}).click();
 await page.getByRole('button',{name:'Use a template'}).click();
 await page.getByRole('button',{name:'QR notice Drag-and-drop layout'}).click();
 await page.getByLabel('Screen name',{exact:true}).fill('Layer test');
 const handle=page.getByRole('button',{name:'Move text layer 1'}),box=await handle.boundingBox();
 await page.mouse.move(box.x+20,box.y+20);await page.mouse.down();await page.mouse.move(box.x+40,box.y+30);await page.mouse.up();
 await page.getByRole('button',{name:'2. qr',exact:true}).click();await page.getByLabel('QR content').fill('https://example.com/studio');
 await page.getByRole('button',{name:'Add image',exact:true}).click();
 const png=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=16;c.height=16;c.getContext('2d').fillRect(0,0,16,16);return c.toDataURL('image/png').split(',')[1];});
 await page.locator('.layout-controls input[type=file]').setInputFiles({name:'logo.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});
 await page.getByLabel('Layer x',{exact:true}).fill('500');await page.getByLabel('Layer y',{exact:true}).fill('30');
 const pixels=await page.locator('canvas[aria-label="Live screen preview"]').evaluate(canvas=>Array.from(canvas.getContext('2d').getImageData(0,0,640,384).data));
 const qr=jsQR(new Uint8ClampedArray(pixels),640,384);assert.equal(qr?.data,'https://example.com/studio');
 await page.screenshot({path:'test-results/layers-desktop.png',fullPage:true});
 await page.getByRole('button',{name:'Save screen',exact:true}).click();await page.getByRole('heading',{name:'Layer test',exact:true}).waitFor();
 const layout=state.presets.find(item=>item.name==='Layer test');assert.equal(layout.kind,'layout');assert.ok(layout.elements[0].x>40);assert.ok(assets.has(layout.elements.find(item=>item.type==='image').asset));
 await page.getByRole('button',{name:'Automations',exact:true}).click();await page.getByRole('button',{name:'Create automation',exact:true}).click();await page.getByLabel('Automation name').fill('Morning playlist');await page.getByLabel('Automation type').selectOption('playlist');await page.getByLabel('Add a saved screen').selectOption(layout.id);await page.getByRole('button',{name:'Add to playlist'}).click();await page.getByLabel('Enable after saving').uncheck();await page.getByRole('button',{name:'Save paused'}).click();await page.getByRole('heading',{name:'Morning playlist',exact:true}).waitFor();assert.equal(state.automations[0].enabled,false);
 await page.getByRole('button',{name:'Enable',exact:true}).click();await page.getByRole('button',{name:'Pause',exact:true}).waitFor();
 await page.getByRole('button',{name:'Diagnostics',exact:true}).click();await page.getByText('2.987 V',{exact:true}).waitFor();await page.getByRole('button',{name:'Read panel',exact:true}).click();await page.getByRole('button',{name:'Looks correct'}).click();await page.getByText('Visually confirmed',{exact:true}).waitFor();
 await page.screenshot({path:'test-results/diagnostics-desktop.png',fullPage:true});
 await page.getByRole('button',{name:'Settings',exact:true}).click();const downloading=page.waitForEvent('download');await page.getByRole('button',{name:'Download full backup'}).click();const downloaded=await downloading,bundle=JSON.parse(await readFile(await downloaded.path(),'utf8'));assert.equal(Object.keys(bundle.assets).length,3,'include full-frame layout and its image dependency');
 state.presets=state.presets.filter(item=>item.id!==layout.id);
 await page.locator('input[type=file][accept="application/json,.json"]').setInputFiles({name:'backup.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(bundle))});
 await page.getByText('Library restored. Automations are paused until you enable them.',{exact:true}).waitFor();assert.ok(state.presets.some(item=>item.id===layout.id));assert.equal(state.automations[0].enabled,false);
 await page.setViewportSize({width:390,height:844});for(const name of ['Displays','Saved screens','Automations','Diagnostics','Live data','Settings']){await page.getByRole('button',{name,exact:true}).click();await page.waitForTimeout(100);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${name} must fit mobile`);}
 await page.screenshot({path:'test-results/features-mobile.png',fullPage:true});assert.deepEqual(errors,[]);
 console.log('PASS: draggable layers, image dependencies, decodable QR, playlist editing, diagnostics, visual confirmation, checksummed backup/restore, paused restored automations, mobile layouts.');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
