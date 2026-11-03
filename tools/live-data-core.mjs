import { createHash } from 'node:crypto';

export function jsonPath(value, path) {
  for (const key of path.replace(/^\$\.?/,'').split('.').filter(Boolean)) {
    if (['__proto__','constructor','prototype'].includes(key) || value === null || typeof value !== 'object' || !Object.hasOwn(value,key)) throw new Error(`JSON field not found: ${path}`);
    value=value[key];
  }
  if (value === null || typeof value === 'object' || value === undefined) throw new Error(`JSON field is not a text value: ${path}`);
  return String(value).slice(0,2000);
}
export function resolveTemplate(preset, variables) {
  const replace=text=>String(text || '').replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g,(_,key)=>{
    if (!Object.hasOwn(variables,key)) throw new Error(`Template variable has no mapping: ${key}`);
    return String(variables[key]);
  });
  return {...preset,dynamic:false,text:replace(preset.text),elements:preset.elements?.map(layer=>({...layer,text:replace(layer.text)}))};
}
export function validateSource(body, previous) {
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(body.id || '') || typeof body.name !== 'string' || !body.name.trim() || body.name.length>40) throw new Error('Choose a source name.');
  if (!['json','clock','weather'].includes(body.kind) || !/^[A-Z]{2}\d{8}[BC]$/.test(body.serial || '') || !/^[A-Za-z0-9_-]{1,32}$/.test(body.preset_id || '')) throw new Error('Choose a source type, registered display, and template.');
  if (!Number.isInteger(body.interval_seconds) || body.interval_seconds<300 || body.interval_seconds>604800) throw new Error('Use an interval from 5 minutes to 7 days.');
  const source={id:body.id,name:body.name.trim(),kind:body.kind,serial:body.serial,preset_id:body.preset_id,interval_seconds:body.interval_seconds,enabled:body.enabled===true,timezone:body.timezone || 'UTC'};
  try { new Intl.DateTimeFormat('en',{timeZone:source.timezone}); } catch { throw new Error('Choose a valid timezone.'); }
  if (body.kind==='json') {
    let url; try { url=new URL(body.url); } catch { throw new Error('Choose an HTTP JSON endpoint.'); }
    if (!['http:','https:'].includes(url.protocol)) throw new Error('Choose an HTTP JSON endpoint.');
    source.url=url.href; source.mapping={};
    for (const [key,path] of Object.entries(body.mapping || {})) {
      if (!/^[A-Za-z0-9_]{1,40}$/.test(key) || typeof path!=='string' || path.length>160) throw new Error('Invalid variable mapping.');
      source.mapping[key]=path;
    }
    if (!Object.keys(source.mapping).length || Object.keys(source.mapping).length>20) throw new Error('Add between 1 and 20 variable mappings.');
    const authorization=Object.hasOwn(body,'authorization') ? body.authorization : previous?.authorization;
    if (authorization) { if (typeof authorization!=='string' || authorization.length>2048 || /[\r\n]/.test(authorization)) throw new Error('Invalid authorization header.'); source.authorization=authorization; }
  }
  if (body.kind==='weather') {
    if (!Number.isFinite(body.latitude) || !Number.isFinite(body.longitude) || Math.abs(body.latitude)>90 || Math.abs(body.longitude)>180) throw new Error('Choose valid weather coordinates.');
    source.latitude=body.latitude;source.longitude=body.longitude;source.temperature_unit=body.temperature_unit==='fahrenheit'?'fahrenheit':'celsius';
  }
  return source;
}
export function publicSource(source) {
  const {authorization,...safe}=source;
  return {...safe,has_authorization:!!authorization};
}
async function boundedJson(url,headers) {
  const response=await fetch(url,{headers,signal:AbortSignal.timeout(10000)});
  if (!response.ok) throw new Error(`Data endpoint returned HTTP ${response.status}.`);
  const reader=response.body.getReader();let bytes=0;const chunks=[];
  while(true){const {value,done}=await reader.read();if(done)break;bytes+=value.length;if(bytes>1048576){await reader.cancel();throw new Error('Data response exceeds 1 MB.');}chunks.push(value);}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export async function sourceVariables(source, now=new Date()) {
  if (source.kind==='clock') return {time:now.toLocaleTimeString('en-US',{timeZone:source.timezone,hour:'numeric',minute:'2-digit'}),date:now.toLocaleDateString('en-US',{timeZone:source.timezone,weekday:'long',month:'short',day:'numeric'})};
  if(source.kind==='weather') {
    const url=new URL('https://api.open-meteo.com/v1/forecast');
    url.search=new URLSearchParams({latitude:String(source.latitude),longitude:String(source.longitude),current:'temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m',temperature_unit:source.temperature_unit || 'celsius'});
    const data=await boundedJson(url);const current=data.current;if(!current || !['temperature_2m','relative_humidity_2m','weather_code','wind_speed_10m'].every(key=>Number.isFinite(current[key])))throw new Error('Weather service returned incomplete data.');
    const code=current.weather_code;
    const condition=code===0?'Clear':code===1?'Mainly clear':code===2?'Partly cloudy':code===3?'Overcast':[45,48].includes(code)?'Fog':code>=51&&code<=57?'Drizzle':code>=61&&code<=67?'Rain':code>=71&&code<=77?'Snow':code>=80&&code<=82?'Rain showers':code>=85&&code<=86?'Snow showers':code>=95?'Thunderstorm':'Weather code '+code;
    return {temperature:Math.round(current.temperature_2m),condition,humidity:current.relative_humidity_2m,wind:current.wind_speed_10m,unit:source.temperature_unit==='fahrenheit'?'F':'C'};
  }
  const data=await boundedJson(source.url,source.authorization?{Authorization:source.authorization}:undefined);
  return Object.fromEntries(Object.entries(source.mapping).map(([key,path])=>[key,jsonPath(data,path)]));
}

export function createEngine({controller,config,save,render,fetchController=fetch,now=()=>Date.now()}) {
  let busy=false;
  async function request(path,body) {
    const response=await fetchController(controller+'/api/v1'+path,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw new Error(`Controller request failed (HTTP ${response.status}).`);return response.json();
  }
  async function tick() {
    if(busy)return;busy=true;
    try {
      for(const source of config.sources) {
        if(!source.enabled&&!source.run_once&&!source.pending_job)continue;
        if(!source.pending_job&&!source.run_once&&(source.next_at||0)>now())continue;
        try {
          const state=await request('/state');
          if(source.pending_job) {
            const job=state.jobs.find(job=>job.id===source.pending_job.id);
            if(job&&['completed','failed','cancelled'].includes(job.state)) {
              if(job.state==='completed'){source.last_hash=source.pending_job.hash;source.last_updated=new Date(now()).toISOString();source.last_error='';}
              else source.last_error=job.error||'Live transfer '+job.state;
              source.pending_job=null;source.next_at=now()+source.interval_seconds*1000;await save();
            } else if(now()-source.pending_job.created_at>600000){source.last_error='The transfer is no longer available in controller history.';source.pending_job=null;await save();}
            continue;
          }
          if(state.jobs.some(job=>job.serial===source.serial&&['queued','sending','retrying'].includes(job.state))){source.next_at=now()+15000;continue;}
          const preset=state.presets.find(item=>item.id===source.preset_id);
          if(!preset||preset.kind==='image'||!state.devices.some(item=>item.serial===source.serial))throw new Error('Choose a registered display and a text/layout template.');
          const variables=await sourceVariables(source,new Date(now()));
          const packet=await render(resolveTemplate(preset,variables));
          const hash=createHash('sha256').update(packet).digest('hex');source.run_once=false;
          if(hash===source.last_hash){source.last_error='';source.next_at=now()+source.interval_seconds*1000;await save();continue;}
          const asset='live-'+now().toString(36)+'-'+Math.random().toString(36).slice(2,7),form=new FormData();form.append('data',new Blob([packet],{type:'application/octet-stream'}),asset+'.bin');
          const upload=await fetchController(controller+'/api/v1/assets',{method:'POST',body:form,signal:AbortSignal.timeout(20000)});
          if(!upload.ok)throw new Error('Controller rejected the rendered image.');
          await request('/presets',{...preset,asset});
          let saved=false;
          for(let n=0;n<30;n++){if((await request('/state')).presets.some(item=>item.id===preset.id&&item.asset===asset)){saved=true;break;}await new Promise(resolve=>setTimeout(resolve,250));}
          if(!saved)throw new Error('Controller did not finish saving the rendered template.');
          const job=await request('/jobs',{serial:source.serial,preset:preset.id});source.pending_job={id:job.id,hash,created_at:now()};source.last_job=job.id;source.last_error='';await save();
        } catch(error){source.last_error=error.message;source.run_once=false;source.next_at=now()+Math.max(30000,source.interval_seconds*1000);await save();}
      }
    } finally {busy=false;}
  }
  return {tick};
}
