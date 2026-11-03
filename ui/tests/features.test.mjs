import {test} from 'node:test';
import assert from 'node:assert/strict';
import {encodePacket,WIDTH,HEIGHT} from '../src/packet.mjs';
import {digest,referencedAssets,validateBackup} from '../src/backup.mjs';
import {jsonPath,resolveTemplate,validateSource,publicSource,createEngine} from '../../tools/live-data-core.mjs';

test('full backup verifies image integrity and includes nested layout assets',()=>{
  const rgba=new Uint8ClampedArray(WIDTH*HEIGHT*4).fill(255);const packet=encodePacket(rgba,WIDTH,HEIGHT,true);
  const config={devices:[{serial:'JM00000000B',name:'Test'}],presets:[{id:'layout',name:'Layout',asset:'main',elements:[{type:'image',asset:'logo'}]}]};
  assert.deepEqual(referencedAssets(config),['main','logo']);
  const item={data:Buffer.from(packet).toString('base64'),sha256:digest(packet)};
  const bundle={format:'chroma-studio/1',config,assets:{main:item,logo:item}};
  assert.equal(validateBackup(bundle).packets.size,2);
  assert.throws(()=>validateBackup({...bundle,assets:{main:{...item,sha256:'bad'},logo:item}}),/checksum/);
  assert.throws(()=>validateBackup({...bundle,assets:{main:item}}),/Missing/);
});
test('JSON paths and live substitutions reject missing and unsafe fields',()=>{
  assert.equal(jsonPath({servers:[{cpu:42}]},'servers.0.cpu'),'42');
  assert.throws(()=>jsonPath({},'__proto__.x'),/not found/);
  assert.throws(()=>jsonPath({a:{}},'a'),/not a text/);
  const resolved=resolveTemplate({text:'CPU {{cpu}}%',elements:[{type:'text',text:'{{status}}'}]},{cpu:'42',status:'Online'});
  assert.equal(resolved.text,'CPU 42%');assert.equal(resolved.elements[0].text,'Online');
  assert.throws(()=>resolveTemplate({text:'{{missing}}'},{}),/no mapping/);
});

test('backup includes historical and last-display packets after templates change',()=>{
 const packet=encodePacket(new Uint8ClampedArray(WIDTH*HEIGHT*4).fill(255),WIDTH,HEIGHT,true);
 const item={data:Buffer.from(packet).toString('base64'),sha256:digest(packet)};
 const config={devices:[{serial:'JM00000000B',name:'Kitchen',last_asset:'current-image'}],presets:[],history:[{id:'old-image',serial:'JM00000000B',asset:'history-image',title:'Previous screen'}]};
 assert.deepEqual(referencedAssets(config),['history-image','current-image']);
 const bundle={format:'chroma-studio/1',config,assets:{'history-image':item,'current-image':item}};
 assert.equal(validateBackup(bundle).packets.size,2);
 assert.throws(()=>validateBackup({...bundle,assets:{'current-image':item}}),/Missing/);
 assert.throws(()=>validateBackup({...bundle,config:{...config,history:[{...config.history[0],serial:'JM99999999B'}]}}),/Invalid image history/);
});
test('source validation bounds intervals and never exposes authorization',()=>{
  const source=validateSource({id:'test',name:'Test',kind:'json',serial:'JM00000000B',preset_id:'preset',url:'http://localhost/status',mapping:{status:'state'},interval_seconds:300,authorization:'Bearer secret',enabled:true});
  assert.equal(publicSource(source).authorization,undefined);assert.equal(publicSource(source).has_authorization,true);
  assert.throws(()=>validateSource({...source,interval_seconds:1}),/interval/);
  assert.throws(()=>validateSource({...source,url:'file:///private'}),/HTTP/);
});
test('live engine waits for acknowledgement and skips unchanged frames',async()=>{
  let now=Date.UTC(2026,10,1),sends=0,rendered=0;
  const source={id:'clock',name:'Clock',kind:'clock',timezone:'UTC',serial:'JM00000000B',preset_id:'preset',interval_seconds:300,enabled:true};
  const preset={id:'preset',name:'Clock',kind:'text',text:'{{date}}',asset:'old'};
  const state={devices:[{serial:source.serial}],presets:[preset],jobs:[]};
  const config={sources:[source]};const saved=[];
  const mock=async(url,options={})=>{
    const path=new URL(url).pathname,body=options.body&&typeof options.body==='string'?JSON.parse(options.body):null;
    if(path.endsWith('/state'))return Response.json(state);
    if(path.endsWith('/assets'))return Response.json({asset:'uploaded'});
    if(path.endsWith('/presets')){Object.assign(preset,body);return Response.json({accepted:true});}
    if(path.endsWith('/jobs')){sends++;const job={id:'job'+sends,serial:source.serial,state:'queued'};state.jobs=[job];return Response.json(job);}
    throw new Error(path);
  };
  const engine=createEngine({controller:'http://controller',config,save:async()=>saved.push(true),now:()=>now,fetchController:mock,render:async design=>{rendered++;assert.ok(!design.text.includes('{{'));return Buffer.from('same-frame');}});
  await engine.tick();assert.equal(sends,1);assert.equal(source.last_hash,undefined);assert.ok(source.pending_job);
  state.jobs[0].state='completed';await engine.tick();assert.ok(source.last_hash);assert.equal(source.pending_job,null);
  now+=301000;await engine.tick();assert.equal(rendered,2);assert.equal(sends,1,'identical frame must not trigger another send');
  source.run_once=true;state.jobs=[{id:'busy',serial:source.serial,state:'sending'}];await engine.tick();assert.equal(rendered,2,'do not render while target is busy');
});
