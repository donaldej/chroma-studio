// Explicit live editor check. Saves and removes one temporary prepared screen;
// no radio transfer or physical panel change is requested.
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {decodePacket} from '../src/packet.mjs';
const controller=process.env.CHROMA_CONTROLLER;if(!controller)throw new Error('Set CHROMA_CONTROLLER. This test briefly saves a temporary image.');
const name='Image preparation self-test';
const request=async(path,body)=>{const response=await fetch(controller+'/api/v1'+path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)});if(!response.ok)throw new Error(await response.text());return response.json();};
const before=await request('/export');assert(!before.presets.some(preset=>preset.name===name));
const browser=await chromium.launch({headless:true,...(process.env.CHROMA_BROWSER_PATH?{executablePath:process.env.CHROMA_BROWSER_PATH}:{})});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1080}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
 page.on('response',response=>{if(['/api/v1/assets','/api/v1/presets'].some(path=>response.url().endsWith(path)))console.log('Image API response:',response.status(),response.url().split('/').pop());});
 await page.goto(controller);await page.getByRole('navigation').getByRole('button',{name:'Saved screens',exact:true}).click();await page.getByRole('button',{name:'Create a screen'}).click();await page.getByRole('button',{name:'Image',exact:true}).click();
 const png=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=640;c.height=384;const ctx=c.getContext('2d'),gradient=ctx.createLinearGradient(0,0,640,0);gradient.addColorStop(0,'black');gradient.addColorStop(1,'white');ctx.fillStyle=gradient;ctx.fillRect(0,0,640,384);return c.toDataURL('image/png').split(',')[1];});
 await page.locator('.image-upload input[type=file]').setInputFiles({name:'gradient.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});await page.getByRole('dialog',{name:'Prepare your image.'}).waitFor();await page.getByLabel('Image colors').selectOption('mono');await page.getByLabel('Dithering').selectOption('floyd');await page.getByRole('button',{name:'Rotate right'}).click();await page.getByLabel('Crop w',{exact:true}).fill('80');await page.getByLabel('Image fit').selectOption('cover');await page.screenshot({path:'test-results/image-preparation-installed.png',fullPage:true});await page.getByRole('button',{name:'Use prepared image'}).click();await page.getByLabel('Screen name',{exact:true}).fill(name);await page.getByRole('button',{name:'Save screen',exact:true}).click();await page.getByRole('heading',{name,exact:true}).waitFor({timeout:30000});
 const saved=(await request('/state')).presets.find(preset=>preset.name===name);assert(saved&&saved.kind==='image');const packet=new Uint8Array(await(await fetch(controller+'/api/v1/assets/'+saved.asset)).arrayBuffer()),pixels=decodePacket(packet);let black=0;for(let i=0;i<pixels.length;i+=4){assert(pixels[i]===23||pixels[i]===255);if(pixels[i]===23)black++;}assert(black>1000&&black<240000);assert.deepEqual(errors,[]);console.log('PASS: deployed crop, rotation and photo dithering saved a valid monochrome display packet');
}catch(error){console.error('Image test failure:',error);throw error;}finally{
 await browser.close();const current=await request('/state');for(const preset of current.presets)if(preset.name===name)await request('/presets/delete',{id:preset.id});
 for(let n=0;n<30;n++){const after=await request('/export');if(!after.presets.some(preset=>preset.name===name)){assert.deepEqual(after,before);console.log('PASS: temporary image removed; original library unchanged');break;}await new Promise(resolve=>setTimeout(resolve,500));}
}
