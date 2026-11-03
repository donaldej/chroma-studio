import {connect} from '../ui/node_modules/mqtt/build/index.js';
import {resolveTemplate} from './live-data-core.mjs';

export function validateMqtt(value,previous={}) {
 const url=new URL(value.url || 'mqtt://localhost:1883');
 if(!['mqtt:','mqtts:'].includes(url.protocol)||url.username||url.password)throw new Error('Use mqtt:// or mqtts:// and enter credentials separately.');
 const prefix=value.prefix || 'chroma-studio',id=value.client_id || 'chroma-studio';
 if(!/^[a-zA-Z0-9_-]{1,48}$/.test(prefix)||!/^[a-zA-Z0-9_-]{1,48}$/.test(id))throw new Error('Topic prefix and client ID need 1–48 letters, digits, underscores or hyphens.');
 if(String(value.username||'').length>128||String(value.password||'').length>256)throw new Error('Credentials are too long.');
 if((value.password || (value.password===undefined&&previous.password))&&!value.username)throw new Error('Enter a username when using an MQTT password.');
 return {enabled:value.enabled===true,url:url.href.replace(/\/$/,''),prefix,client_id:id,discovery:value.discovery!==false,username:String(value.username||''),password:typeof value.password==='string'?value.password:previous.password||''};
}
export const publicMqtt=value=>{const {password,...rest}=value||{};return {...rest,has_password:!!password};};

export function createMqttBridge({controller,config,save,render,request,connectClient=connect}) {
 let client,settings,connected=false,lastError='',controllerOnline=false,busy=false,queue=Promise.resolve(),pending=0,lastState;
 const discovered=new Set(),sent=new Map(),pendingBySerial=new Map();
 function publish(topic,value,retain=true){if(client?.connected)client.publish(topic,typeof value==='string'?value:JSON.stringify(value),{retain,qos:1});}
 function result(value){publish(settings.prefix+'/result',value,false);}
 async function command(topic,payload,packet={}) {
  if(packet.retain)throw new Error('Retained commands are ignored.');
  if(payload.length>4096)throw new Error('Command exceeds 4 KB.');
  let body;
  if(topic===settings.prefix+'/command')body=JSON.parse(payload.toString());
  else {const serial=topic.slice((settings.prefix+'/display/').length,-'/send'.length);body={serial,preset:payload.toString()};}
  if(!body||typeof body!=='object'||typeof body.serial!=='string'||typeof body.preset!=='string')throw new Error('Use serial and preset in the command.');
  const requestId=body.request_id;
  if(requestId!==undefined&&(!/^[a-zA-Z0-9_-]{1,64}$/.test(requestId)))throw new Error('Invalid request_id.');
  const previous=(config.mqtt_requests||[]).find(item=>item.id===requestId);
  if(requestId&&previous){result({...previous,duplicate:true});return;}
  const state=await request('/state');
  const preset=state.presets.find(item=>item.id===body.preset),device=state.devices.find(item=>item.serial===body.serial);
  if(!preset||!device)throw new Error('Unknown display or preset.');
  const pendingJob=pendingBySerial.get(body.serial);
  if(pendingJob){const reported=state.jobs.find(job=>job.id===pendingJob.id);if(!['completed','failed','cancelled'].includes(reported?.state)&&Date.now()-pendingJob.at<600000)throw new Error('Display already has a pending transfer.');pendingBySerial.delete(body.serial);}
  if(state.jobs.some(job=>job.serial===body.serial&&['queued','sending','retrying'].includes(job.state)))throw new Error('Display already has a pending transfer.');
  let job;
  if(body.variables!==undefined){
   if(!body.variables||Array.isArray(body.variables)||typeof body.variables!=='object'||Object.keys(body.variables).length>20||Object.values(body.variables).some(value=>!['string','number','boolean'].includes(typeof value)||String(value).length>1000))throw new Error('Use up to 20 short text, numeric or boolean variables.');
   if(preset.kind==='image')throw new Error('Variables need a text or layout template.');
   const bytes=await render(resolveTemplate(preset,body.variables)),asset='mqtt-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,7);
   const form=new FormData();form.append('data',new Blob([bytes],{type:'application/octet-stream'}),asset+'.bin');
   const response=await fetch(controller+'/api/v1/assets',{method:'POST',body:form,signal:AbortSignal.timeout(20000)});
   if(!response.ok)throw new Error('Rendered frame upload failed.');
   job=await request('/jobs/frame',{serial:body.serial,asset,title:preset.name});
  }else job=await request('/jobs',{serial:body.serial,preset:preset.id});
  const accepted={id:requestId,serial:body.serial,preset:body.preset,job_id:job.id,status:'queued'};
  pendingBySerial.set(body.serial,{id:job.id,at:Date.now()});
  if(requestId){config.mqtt_requests=[...(config.mqtt_requests||[]).slice(-63),accepted];await save();}
  result(accepted);
 }
 function discover(state) {
  const next=new Set(),prefix=settings.prefix;
  const register=(component,id,data)=>{
   const topic=`homeassistant/${component}/${settings.client_id}_${id}/config`;next.add(topic);
   const text=JSON.stringify(data);if(sent.get(topic)!==text){publish(topic,text);sent.set(topic,text);}
  };
  if(settings.discovery)register('sensor','controller',{unique_id:settings.client_id+'_controller',name:'Radio state',device:{identifiers:[settings.client_id],name:'Chroma Studio',manufacturer:'Chroma Studio',model:'T-Embed CC1101 Plus'},state_topic:prefix+'/controller/state',value_template:'{{ value_json.radio_mode }}',availability:[{topic:prefix+'/availability'},{topic:prefix+'/controller/availability'}],availability_mode:'all'});
  if(settings.discovery)for(const device of state.devices){
   const base=prefix+'/display/'+device.serial,identity={identifiers:[settings.client_id+'_'+device.serial],name:device.name,manufacturer:'Chroma Studio',model:'Chroma74',via_device:settings.client_id};
   const common={device:identity,availability:[{topic:prefix+'/availability'},{topic:prefix+'/controller/availability'}],availability_mode:'all',state_topic:base+'/state'};
   register('sensor',device.serial+'_status',{...common,unique_id:settings.client_id+'_'+device.serial+'_status',name:'Transfer status',value_template:'{{ value_json.status }}'});
   register('sensor',device.serial+'_ack',{...common,unique_id:settings.client_id+'_'+device.serial+'_ack',name:'Acknowledgement rate',unit_of_measurement:'%',value_template:'{{ value_json.ack_rate }}'});
   if(state.presets.length)register('select',device.serial+'_screen',{...common,unique_id:settings.client_id+'_'+device.serial+'_screen',name:'Saved screen',command_topic:base+'/send',options:state.presets.map(preset=>preset.id),value_template:'{{ value_json.preset }}',qos:0,retain:false});
  }
  for(const topic of discovered)if(!next.has(topic)){publish(topic,'');sent.delete(topic);}
  discovered.clear();for(const topic of next)discovered.add(topic);
 }
 async function tick(){
  if(busy||!client?.connected)return;busy=true;
  try{
   const state=await request('/state');lastState=state;controllerOnline=true;publish(settings.prefix+'/controller/availability','online');
   publish(settings.prefix+'/controller/state',{version:state.controller.version,radio_mode:state.controller.radio_mode,ip:state.controller.ip});
   discover(state);
   for(const device of state.devices){
    const job=state.jobs.find(job=>job.serial===device.serial),stats=device.radio_stats||{};
    publish(settings.prefix+'/display/'+device.serial+'/state',{name:device.name,status:job?.state||'idle',preset:device.last_preset||'',image_id:device.last_image_id||'',visually_confirmed:!!device.visual_confirmed,ack_rate:stats.jobs?Math.round(100*(stats.acknowledged||0)/stats.jobs):null,retries:stats.retries||0,job:job?{id:job.id,state:job.state,progress:job.progress,attempts:job.attempts,error:job.error}:null});
   }
  }catch{controllerOnline=false;publish(settings.prefix+'/controller/availability','offline');}
  finally{busy=false;}
 }
 async function stop(){
  if(client){publish(settings.prefix+'/availability','offline');for(const topic of discovered)publish(topic,'');await new Promise(resolve=>client.end(false,{},resolve));client=undefined;}
  connected=false;controllerOnline=false;discovered.clear();sent.clear();
 }
 async function configure(){
  await queue;await stop();lastError='';settings=validateMqtt(config.mqtt||{});
  if(!settings.enabled)return;
  client=connectClient(settings.url,{clientId:settings.client_id,username:settings.username||undefined,password:settings.password||undefined,reconnectPeriod:5000,connectTimeout:10000,clean:true,queueQoSZero:false,will:{topic:settings.prefix+'/availability',payload:'offline',qos:1,retain:true}});
  client.on('connect',()=>{connected=true;lastError='';sent.clear();publish(settings.prefix+'/availability','online');client.subscribe([settings.prefix+'/command',settings.prefix+'/display/+/send','homeassistant/status'],{qos:0});tick();});
  client.on('close',()=>{connected=false;controllerOnline=false;});
  client.on('error',()=>{lastError='Cannot connect to MQTT broker. Check its address, credentials and TLS configuration.';});
  client.on('message',(topic,payload,packet)=>{
   if(topic==='homeassistant/status'){if(payload.toString()==='online'){sent.clear();tick();}return;}
   if(pending>=16){result({status:'rejected',error:'MQTT command queue is full.'});return;}
   pending++;queue=queue.then(()=>command(topic,payload,packet)).catch(error=>result({status:'rejected',error:error.message})).finally(()=>pending--);
  });
 }
 return {configure,tick,stop,status:()=>({...publicMqtt(config.mqtt),connected,controller_online:controllerOnline,last_error:lastError,topics:settings?{command:settings.prefix+'/command',result:settings.prefix+'/result'}:{},presets:lastState?.presets.map(({id,name})=>({id,name}))||[]})};
}
