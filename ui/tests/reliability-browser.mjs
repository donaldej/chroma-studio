import {chromium} from 'playwright';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {encodePacket,WIDTH,HEIGHT} from '../src/packet.mjs';
const pixels=new Uint8ClampedArray(WIDTH*HEIGHT*4).fill(255);pixels.set([0,0,0,255],0);
const packet=Buffer.from(encodePacket(pixels,WIDTH,HEIGHT,true)),serial='JM00000000B';
const state={revision:1,controller:{name:'Studio',version:'0.4.0',ip:'192.0.2.1',radio_mode:'Idle',connected:true},settings:{brightness:180,screen_timeout:120,max_attempts:2,timezone:'UTC',companion_url:'http://companion.test:8787'},devices:[{serial,name:'Kitchen',id:123,channel:0,network:1,wake_channel:4,palette:'bwy',last_preset:'welcome',last_asset:'historical',last_image_id:'previous',radio_stats:{jobs:4,acknowledged:3,failed:1,retries:2,attempts:6,duration_ms:20000}}],presets:[{id:'welcome',name:'Welcome',asset:'current',kind:'text',text:'Edited version'}],history:[{id:'previous',serial,preset:'welcome',asset:'historical',title:'Original image',at:1793570000,attempts:2,duration_ms:12000,confirmed:false}],automations:[],jobs:[]};
let checks=0,resend,mqttSaved;
let mqtt={enabled:false,url:'mqtt://localhost:1883',prefix:'chroma-studio',client_id:'chroma-studio',username:'',discovery:true,connected:false};
const server=createServer(async(req,res)=>{try{const name=req.url==='/'?'index.htm':req.url.split('/').pop();res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html');res.end(await readFile('dist/'+name));}catch{res.statusCode=404;res.end();}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));await mkdir('test-results',{recursive:true});
const browser=await chromium.launch({headless:true,...(process.env.CHROMA_BROWSER_PATH?{executablePath:process.env.CHROMA_BROWSER_PATH}:{})});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>dialog.accept());
 await page.route('http://companion.test:8787/**',async route=>{if(route.request().method()==='POST'){mqttSaved=route.request().postDataJSON();mqtt={...mqtt,...mqttSaved,connected:true,controller_online:true,has_password:true};delete mqtt.password;}await route.fulfill({contentType:'application/json',headers:{'Access-Control-Allow-Origin':'*'},body:JSON.stringify(mqtt)});});
 await page.route('**/api/v1/**',async route=>{
  const req=route.request(),path=new URL(req.url()).pathname;const respond=data=>route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
  if(path.endsWith('/state'))return respond(state);
  if(path.startsWith('/api/v1/assets/'))return route.fulfill({contentType:'application/octet-stream',body:packet});
  const body=req.postDataJSON();
  if(path.endsWith('/history/resend')){resend=body;return respond({id:'resent'});}
  if(path.endsWith('/history/clear')){state.history=state.history.filter(entry=>entry.id!==body.id);return respond({accepted:true});}
  if(path.endsWith('/displays/inspect')){checks++;const id='probe-'+checks;state.jobs.push({id,serial,query:'panel',kind:'inspect',state:'completed',progress:100,total:1,remaining:0,title:'Read panel',error:''});return respond({id});}
  return route.fulfill({status:404,body:'{}'});
 });
 await page.goto(`http://127.0.0.1:${server.address().port}`);
 await page.getByRole('navigation').getByRole('button',{name:'History',exact:true}).click();
 await page.getByRole('heading',{name:'Original image'}).waitFor();
 const canvas=page.getByLabel('Previously sent Original image');await page.waitForFunction(()=>document.querySelector('canvas')?.getContext('2d').getImageData(0,0,1,1).data[3]===255);
 assert((await canvas.evaluate(canvas=>Array.from(canvas.getContext('2d').getImageData(0,0,1,1).data)))[0]<50);
 await page.getByRole('button',{name:'Resend this image'}).click();assert.deepEqual(resend,{id:'previous'});
 await page.screenshot({path:'test-results/history-desktop.png',fullPage:true});
 await page.getByRole('navigation').getByRole('button',{name:'Diagnostics',exact:true}).click();await page.getByText('75%',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Run connection test'}).click();await page.getByText('Connection test: 3 acknowledged, 0 failed, 0 pending.',{exact:true}).waitFor();assert.equal(checks,3);
 await page.getByRole('navigation').getByRole('button',{name:'Settings',exact:true}).click();
 await page.getByLabel('Broker address').fill('mqtt://192.0.2.20:1883');await page.getByLabel('Username',{exact:true}).fill('studio');await page.getByLabel('Password',{exact:true}).fill('test-secret');await page.getByLabel('Enable MQTT',{exact:true}).check();await page.getByRole('button',{name:'Save MQTT settings'}).click();await page.getByText('Broker and controller connected',{exact:true}).waitFor();assert.equal(mqttSaved.password,'test-secret');assert.equal(mqttSaved.enabled,true);assert.equal(await page.getByLabel('Password',{exact:true}).inputValue(),'');
 await page.setViewportSize({width:390,height:844});for(const name of ['Settings','History','Diagnostics']){await page.getByRole('navigation').getByRole('button',{name,exact:true}).click();await page.waitForTimeout(200);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,name+' fits mobile');}
 await page.screenshot({path:'test-results/reliability-mobile.png',fullPage:true});assert.deepEqual(errors,[]);
 console.log('PASS: historical packet preview/resend, radio measurements, three-read guided test, private MQTT setup and mobile layouts');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
