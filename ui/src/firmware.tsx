import React,{useEffect,useRef,useState} from 'react';
import type {State} from './types';
import {api} from './api';
import {inspectFirmware} from './firmware.mjs';
type Status={version:string;board:string;running_slot:string;update_slot:string;max_bytes:number;rollback_available:boolean;status:string;last_error:string};
type Manifest={version:string;bytes:number;sha256:string};
export function FirmwareUpdates({state,notify}:{state:State;notify:(text:string,error?:boolean)=>void}){
 const [status,setStatus]=useState<Status>(),[chosen,setChosen]=useState<{file:File;manifest:Manifest}>(),[error,setError]=useState(''),[phase,setPhase]=useState(''),[progress,setProgress]=useState(0);
 const input=useRef<HTMLInputElement>(null),xhr=useRef<XMLHttpRequest|null>(null),alive=useRef(true);
 useEffect(()=>{alive.current=true;api('/firmware').then(setStatus).catch(()=>setError('Firmware updating is unavailable on this controller. Install Studio 0.5 or newer over USB first.'));return()=>{alive.current=false;xhr.current?.abort();};},[]);
 const busy=!!phase&&phase!=='verified',pending=state.jobs.some(job=>['queued','sending','retrying'].includes(job.state));
 async function reconnect(previous:string,expected?:string){
  setPhase('Waiting for the controller to restart');
  for(let n=0;n<60;n++){await new Promise(resolve=>setTimeout(resolve,2000));if(!alive.current)return;try{const next=await api('/firmware') as Status;if(next.running_slot!==previous&&(!expected||next.version===expected)){setStatus(next);setPhase('verified');setChosen(undefined);notify('Firmware boot verified. Your library and Wi-Fi settings are preserved.');return;}}catch{}}
  throw new Error('Could not confirm the reboot. Reopen the controller address before retrying. USB recovery instructions are below.');
 }
 async function install(){
  if(!chosen||!status)return;
  if(!confirm(`Install Studio ${chosen.manifest.version}? The controller will restart. Keep it powered until verification finishes. Saved screens and Wi-Fi settings are preserved.`))return;
  setError('');setPhase('Uploading firmware');setProgress(0);
  try{
   const result=await new Promise<{token:string}>((resolve,reject)=>{
    const request=new XMLHttpRequest();xhr.current=request;request.open('POST','/api/v1/firmware/upload');request.setRequestHeader('X-Chroma-Update','1');request.timeout=180000;
    request.upload.onprogress=event=>{if(event.lengthComputable){setProgress(Math.round(event.loaded/event.total*100));if(event.loaded===event.total)setPhase('Verifying the uploaded firmware');}};
    request.onload=()=>{xhr.current=null;let body;try{body=JSON.parse(request.responseText);}catch{reject(new Error('Unexpected firmware response.'));return;}if(request.status<200||request.status>=300)reject(new Error(body.error||'Firmware rejected.'));else resolve(body);};
    request.onerror=()=>reject(new Error('Upload connection failed. The running firmware remains selected.'));request.ontimeout=()=>reject(new Error('Upload timed out. Reopen the controller before retrying.'));request.onabort=()=>reject(new Error('Upload cancelled. The running firmware remains selected.'));
    const form=new FormData();form.append('firmware',chosen.file);request.send(form);
   });
   setPhase('Installing firmware');
   const response=await fetch('/api/v1/firmware/commit',{method:'POST',headers:{'Content-Type':'application/json','X-Chroma-Update':'1'},body:JSON.stringify({token:result.token}),signal:AbortSignal.timeout(10000)});
   if(!response.ok)throw new Error((await response.json()).error||'Firmware could not be selected.');
   await reconnect(status.running_slot,chosen.manifest.version);
  }catch(error){if(alive.current){setError((error as Error).message);setPhase('');}}
  finally{xhr.current=null;}
 }
 return <section className="settings-card"><span className="eyebrow">CONTROLLER SOFTWARE</span><h2>Firmware updates.</h2><p className="muted">Install a Chroma Studio package over Wi-Fi. Firmware and its web interface update together in the inactive application slot.</p><p>Installed: <strong>{status?.version||state.controller.version}</strong>{status&&<span className="small muted"> · slot {status.running_slot}</span>}</p><input hidden type="file" accept=".chroma" ref={input} onChange={async event=>{const file=event.target.files?.[0];setChosen(undefined);setError('');setPhase('');if(!file)return;try{if(file.size>(status?.max_bytes||0x640000)+1036)throw new Error('Package exceeds the controller’s update capacity.');const manifest=inspectFirmware(new Uint8Array(await file.arrayBuffer()),status?.max_bytes) as Manifest;setChosen({file,manifest});}catch(error){setError((error as Error).message);}finally{event.target.value='';}}}/>
 <div className="feature-actions"><button className="button secondary" disabled={!status||busy} onClick={()=>input.current?.click()}>Choose firmware package</button>{chosen&&<button className="button primary" disabled={busy||pending} onClick={install}>Install update</button>}{xhr.current&&phase==='Uploading firmware'&&<button className="button secondary" onClick={()=>xhr.current?.abort()}>Cancel upload</button>}</div>
 {chosen&&<div className="firmware-package"><strong>Studio {chosen.manifest.version}</strong><p>{chosen.file.name} · {(chosen.manifest.bytes/1024/1024).toFixed(2)} MB · SHA-256 verified</p><code>{chosen.manifest.sha256}</code></div>}{pending&&<p className="small muted">Finish or cancel pending display transfers before updating.</p>}{busy&&<div role="status"><p>{phase}{phase==='Uploading firmware'?` — ${progress}%`:''}</p><progress max={100} value={progress}/><p className="small muted">Keep this page open and the controller powered.</p></div>}{phase==='verified'&&<p role="status">Firmware boot verified. Refresh this page to load the updated interface.</p>}{error&&<p className="form-error" role="alert">{error}</p>}
 <details><summary>Recovery and previous firmware</summary><p>Only install packages you built or trust. Compatibility and checksum checks do not authenticate their publisher. Uploading leaves the running application selected until the full package passes validation. Wi-Fi settings, saved screens, schedules and history stay in their data partitions.</p><p>Automatic crash rollback is not enabled in this build. If the controller remains reachable, switch to the previous application below. If it cannot boot or connect, use USB recovery.</p><button className="button secondary" disabled={busy||pending||!status?.rollback_available} onClick={async()=>{if(!status||!confirm('Restart into the previous application? This changes software only; library data is not rolled back.'))return;setError('');setPhase('Selecting previous firmware');try{const response=await fetch('/api/v1/firmware/rollback',{method:'POST',headers:{'Content-Type':'application/json','X-Chroma-Update':'1'},body:'{}'});if(!response.ok)throw new Error((await response.json()).error);await reconnect(status.running_slot);}catch(error){setError((error as Error).message);setPhase('');}}}>Use previous firmware</button><p className="small muted">USB recovery: hold BOOT while reconnecting USB, release BOOT, then use the project’s USB recovery command below. Avoid erase-flash and filesystem uploads to preserve your data. A previous application appears after a successful OTA install.</p><pre className="diagnostic-raw">.venv/Scripts/python.exe tools/recover_firmware.py --port COM12 --firmware artifacts/studio-05/firmware.bin</pre><p className="small muted">Build packages with tools/package_firmware.py. See docs/updates-and-images.md for recovery when the active OTA slot differs from the USB upload slot.</p></details></section>;
}
