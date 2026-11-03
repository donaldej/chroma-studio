// Isolated integration: real companion/browser renderer, fake controller and feed.
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdir,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
import {decodePacket} from '../src/packet.mjs';
await mkdir('test-results',{recursive:true});
const preset={id:'template',name:'Status',kind:'text',text:'{{status}}\nCPU {{cpu}}%',color:'black',background:'white',font_size:48,font:'sans',align:'center',template:'center',dynamic:true,asset:'old'};
const state={devices:[{serial:'JM00000000B'}],presets:[preset],jobs:[]};const assets=new Map();let sends=0,authorized=false;
const mock=createServer(async(req,res)=>{
 try{
  const path=new URL(req.url,'http://localhost').pathname;let data;
  if(path==='/data'){authorized=req.headers.authorization==='Bearer test-secret';if(!authorized){res.statusCode=401;res.end();return;}data={status:'Online',cpu:42};}
  else if(path==='/api/v1/state')data=state;
  else{const chunks=[];for await(const chunk of req)chunks.push(chunk);const bytes=Buffer.concat(chunks);
   if(path==='/api/v1/assets'){const name=bytes.toString('latin1').match(/filename="([^"]+)"/)[1].replace('.bin',''),at=bytes.indexOf(Buffer.from([0x83,0x19,0])),length=bytes.readUInt16LE(at+7)+39;assets.set(name,bytes.subarray(at,at+length));data={asset:name};}
   else if(path==='/api/v1/presets'){Object.assign(preset,JSON.parse(bytes));data={accepted:true};}
   else if(path==='/api/v1/jobs'){sends++;data={id:'job'+sends};state.jobs=[{...data,state:'completed',serial:'JM00000000B',error:''}];}
   else{res.statusCode=404;res.end();return;}
  }
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify(data));
 }catch(e){res.statusCode=500;res.end(e.message);}
});
await new Promise(resolve=>mock.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${mock.address().port}`,port=18787,base=`http://127.0.0.1:${port}`;
const config=resolve('test-results/companion-'+Date.now()+'.json');
const child=spawn(process.execPath,['tools/live-data.mjs','--controller',origin,'--port',String(port),'--config',config,'--exit-on-stdin'],{cwd:resolve('..'),env:process.env,stdio:['pipe','pipe','pipe']});
let output='';child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>output+=data);
async function request(path,body,headers={}){const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});return{response:r,data:await r.json()};}
async function waitFor(fn){const end=Date.now()+45000;while(Date.now()<end){if(child.exitCode!==null)throw new Error(output);try{const v=await fn();if(v)return v;}catch{}await new Promise(resolve=>setTimeout(resolve,300));}throw new Error('Companion did not reach expected state: '+output);}
try{
 await waitFor(async()=> (await request('/live/state')).data.running);
 const denied=await request('/live/state',undefined,{Origin:'http://untrusted.example'});assert.equal(denied.response.status,403);
 const source={id:'source',name:'Server',kind:'json',serial:'JM00000000B',preset_id:'template',interval_seconds:300,enabled:true,url:origin+'/data',mapping:{status:'status',cpu:'cpu'},authorization:'Bearer test-secret',timezone:'UTC'};
 assert.equal((await request('/live/sources',source)).response.status,202);
 const ready=await waitFor(async()=>{const s=(await request('/live/state')).data.sources[0];return s?.last_updated?s:null;});
 assert.equal(sends,1);assert.ok(authorized);assert.equal(ready.authorization,undefined);assert.ok(!JSON.stringify(ready).includes('test-secret'));assert.equal(preset.text,'{{status}}\nCPU {{cpu}}%','preserve template variables');
 const frame=assets.get(preset.asset);assert.ok(frame);assert.equal(frame.length,61479);const pixels=decodePacket(frame);assert.ok(pixels.some((value,index)=>index%4!==3&&value<100),'renderer must produce visible text');
 await request('/live/sources/run',{id:'source'});await new Promise(resolve=>setTimeout(resolve,1800));assert.equal(sends,1,'skip unchanged image');
 const broken={...source,mapping:{status:'missing',cpu:'cpu'}};delete broken.authorization;await request('/live/sources',broken);
 await waitFor(async()=> (await request('/live/state')).data.sources[0]?.last_error?.includes('not found'));
 assert.equal(sends,1,'bad data must retain previous image');
 const stored=JSON.parse(await readFile(config,'utf8'));assert.equal(stored.sources[0].authorization,'Bearer test-secret');
 console.log('PASS: real browser rendering, authenticated JSON fetch, variable retention, real packet upload, acknowledged hash, unchanged suppression, bad-data retention, private header handling, browser-origin rejection.');
}finally{
 child.stdin.end();await Promise.race([new Promise(resolve=>child.once('exit',resolve)),new Promise(resolve=>setTimeout(resolve,10000))]);if(child.exitCode===null)child.kill();await new Promise(resolve=>mock.close(resolve));
}
