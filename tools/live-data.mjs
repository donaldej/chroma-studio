import {createServer,request as proxyRequest} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {readFile,writeFile,rename,mkdir,chmod} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve,dirname,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {networkInterfaces,hostname} from 'node:os';
import {createEngine,validateSource,publicSource} from './live-data-core.mjs';
import {createMqttBridge,validateMqtt} from './mqtt-bridge.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2),option=(name,fallback)=>args.includes(name)?args[args.indexOf(name)+1]:fallback;
const controller=new URL(option('--controller',process.env.CHROMA_CONTROLLER || 'http://chroma.local')).origin;
const host=option('--host','127.0.0.1'),port=Number(option('--port','8787'));
const configPath=resolve(option('--config',root+'/artifacts/live-data/config.json'));
let config={sources:[]};
try{config=JSON.parse(await readFile(configPath,'utf8'));if(!Array.isArray(config.sources))throw new Error('Invalid sources');}catch(error){if(error.code!=='ENOENT')throw error;}
let writing=Promise.resolve();
function save(){const text=JSON.stringify(config,null,2)+'\n';writing=writing.catch(()=>{}).then(async()=>{await mkdir(dirname(configPath),{recursive:true});await writeFile(configPath+'.tmp',text,{mode:0o600});await rename(configPath+'.tmp',configPath);if(process.platform!=='win32')await chmod(configPath,0o600);});return writing;}
let browser,page,starting;
async function render(design){
  if(!page){
    if(!starting)starting=(async()=>{const{chromium}=await import('../ui/node_modules/playwright/index.mjs');const edge='C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';const executablePath=process.env.CHROMA_BROWSER_PATH || (process.platform==='win32'&&existsSync(edge)?edge:undefined);browser=await chromium.launch({headless:true,...(executablePath?{executablePath}:{})});page=await browser.newPage();await page.goto(`http://127.0.0.1:${port}/render.html`);await page.waitForFunction(()=>typeof window.renderStudioFrame==='function');})();
    try{await starting;}catch{starting=null;page=null;throw new Error('Renderer unavailable. Build ui/ and install Playwright Chromium or set CHROMA_BROWSER_PATH.');}
  }
  const assets={};for(const layer of design.elements||[])if(layer.type==='image'&&layer.asset){const response=await fetch(controller+'/api/v1/assets/'+encodeURIComponent(layer.asset),{signal:AbortSignal.timeout(10000)});if(!response.ok)throw new Error('A template layer image is missing.');assets[layer.asset]=Buffer.from(await response.arrayBuffer()).toString('base64');}
  return Buffer.from(await page.evaluate(({design,assets})=>window.renderStudioFrame(design,assets),{design,assets}));
}
const engine=createEngine({controller,config,save,render});
async function controllerRequest(path,body){const response=await fetch(controller+'/api/v1'+path,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});if(!response.ok)throw new Error('Controller request failed (HTTP '+response.status+').');return response.json();}
const mqtt=createMqttBridge({controller,config,save,render,request:controllerRequest});
const origins=new Set([controller,'http://chroma.local',`http://localhost:${port}`,`http://127.0.0.1:${port}`,`http://${hostname()}:${port}`,`http://${hostname()}.local:${port}`]);
for(const list of Object.values(networkInterfaces()))for(const item of list||[])if(item.family==='IPv4')origins.add(`http://${item.address}:${port}`);
for(const origin of [...origins]){origins.delete(origin);origins.add(new URL(origin).origin);}
if(args.includes('--allow-origin'))origins.add(new URL(option('--allow-origin')).origin);
function json(response,status,data){response.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});response.end(JSON.stringify(data));}
async function body(request){let text='';for await(const chunk of request){text+=chunk;if(text.length>12000)throw new Error('Request is too large.');}return JSON.parse(text);}
const server=createServer(async(request,response)=>{
  try{
    const path=new URL(request.url,'http://localhost').pathname;
    if(path.startsWith('/live/')&&request.headers.origin){if(!origins.has(request.headers.origin))return json(response,403,{error:'This browser origin is not allowed.'});response.setHeader('Access-Control-Allow-Origin',request.headers.origin);response.setHeader('Vary','Origin');}
    if(request.method==='OPTIONS'){response.writeHead(204,{'Access-Control-Allow-Headers':'Content-Type','Access-Control-Allow-Methods':'GET,POST,OPTIONS'});response.end();return;}
    if(path==='/live/state'&&request.method==='GET')return json(response,200,{running:true,controller,sources:config.sources.map(publicSource),browser_ready:!!page});
    if(path==='/live/mqtt'&&request.method==='GET')return json(response,200,mqtt.status());
    if(path.startsWith('/live/')&&request.method==='POST'){
      const value=await body(request);
      if(path==='/live/mqtt'){
        config.mqtt=validateMqtt(value,config.mqtt);await save();await mqtt.configure();return json(response,202,{accepted:true});
      } else if(path==='/live/sources'){
        const previous=config.sources.find(source=>source.id===value.id),source=validateSource(value,previous);
        if(!previous&&config.sources.length>=20)throw new Error('The companion supports 20 live sources.');
        const index=config.sources.findIndex(item=>item.id===source.id);if(index<0)config.sources.push(source);else config.sources[index]=source;
      }else{
        const source=config.sources.find(item=>item.id===value.id);if(!source)return json(response,404,{error:'Source not found.'});
        if(path==='/live/sources/toggle'){source.enabled=value.enabled===true;source.next_at=0;}
        else if(path==='/live/sources/run'){source.run_once=true;source.next_at=0;}
        else if(path==='/live/sources/delete'){config.sources=config.sources.filter(item=>item.id!==source.id);}
        else return json(response,404,{error:'Not found.'});
      }
      await save();json(response,202,{accepted:true});setTimeout(()=>engine.tick().catch(()=>{}),0);return;
    }
    if(path.startsWith('/api/')||path.startsWith('/wifi')){
      const target=new URL(request.url,controller),send=target.protocol==='https:'?httpsRequest:proxyRequest;
      const upstream=send(target,{method:request.method,headers:{...request.headers,host:target.host}},result=>{response.writeHead(result.statusCode,result.headers);result.pipe(response);});upstream.on('error',()=>json(response,502,{error:'Controller is unreachable.'}));request.pipe(upstream);return;
    }
    if(path==='/render.html'){response.writeHead(200,{'Content-Type':'text/html'});response.end('<!doctype html><script src="/render-worker.js"></script>');return;}
    const name=path==='/'?'index.htm':basename(path);
    if(!['index.htm','app.js','app.css','render-worker.js'].includes(name))return json(response,404,{error:'Not found.'});
    const data=await readFile(root+'/ui/dist/'+name);response.writeHead(200,{'Content-Type':name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html','Cache-Control':'no-store'});response.end(data);
  }catch(error){json(response,400,{error:error.message});}
});
await new Promise(resolve=>server.listen(port,host,resolve));
console.log(`Chroma Studio live data: http://${host}:${port}; controller ${controller}`);
await mqtt.configure();
const timer=setInterval(()=>{engine.tick().catch(()=>{});mqtt.tick().catch(()=>{});},5000);engine.tick().catch(()=>{});
async function shutdown(){clearInterval(timer);server.close();await mqtt.stop();await writing;await browser?.close();process.exit(0);}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
if(args.includes('--exit-on-stdin')){process.stdin.resume();process.stdin.on('end',shutdown);}
