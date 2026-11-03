// Explicit live test. Installs a package, optionally switches back, then installs
// the package again so the controller ends on the selected release.
import {chromium} from 'playwright';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {inspectFirmware} from '../src/firmware.mjs';
const controller=process.env.CHROMA_CONTROLLER,firmware=process.env.CHROMA_FIRMWARE_PACKAGE;
if(!controller||!firmware)throw new Error('Set CHROMA_CONTROLLER and CHROMA_FIRMWARE_PACKAGE. This test installs real firmware.');
const manifest=inspectFirmware(new Uint8Array(await readFile(firmware)));
const request=async path=>{const response=await fetch(controller+'/api/v1'+path,{signal:AbortSignal.timeout(15000)});if(!response.ok)throw new Error('Controller unavailable');return response.json();};
async function idle(){const end=Date.now()+150000;while(Date.now()<end){if(!(await request('/state')).jobs.some(job=>['queued','sending','retrying'].includes(job.state)))return;await new Promise(resolve=>setTimeout(resolve,1000));}throw new Error('Transfers did not finish');}
// last_ack is a controller-uptime value, deliberately reset to zero on boot.
const stableLibrary=value=>({...value,devices:value.devices.map(device=>({...device,last_ack:0}))});
const before=stableLibrary(await request('/export')),initial=await request('/firmware'),evidence={initial,version:manifest.version,boots:[]};
assert(!(await request('/state')).jobs.some(job=>['queued','sending','retrying'].includes(job.state)));
await mkdir('test-results',{recursive:true});
const browser=await chromium.launch({headless:true,...(process.env.CHROMA_BROWSER_PATH?{executablePath:process.env.CHROMA_BROWSER_PATH}:{})});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1100}}),errors=[];page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>dialog.accept());
 page.on('response',async response=>{if(['/firmware/upload','/firmware/commit','/firmware/rollback'].some(path=>response.url().endsWith(path))){let body={};try{body=await response.json();delete body.token;}catch{}console.log('OTA response:',response.status(),response.url().split('/').pop(),JSON.stringify(body));}});
 await page.goto(controller);await page.getByRole('navigation').getByRole('button',{name:'Settings',exact:true}).click();
 async function install(){
  await idle();const old=await request('/firmware');await page.locator('input[accept=".chroma"]').setInputFiles(firmware);await page.getByRole('button',{name:'Install update',exact:true}).click();
  await page.getByText('Firmware boot verified. Refresh this page to load the updated interface.',{exact:true}).waitFor({timeout:180000});
  const current=await request('/firmware');assert.notEqual(current.running_slot,old.running_slot);assert.equal(current.version,manifest.version);evidence.boots.push({action:'install',...current});
  assert.deepEqual(stableLibrary(await request('/export')),before,'Library and Wi-Fi-independent settings preserved');console.log('PASS: browser upload, validation, commit and boot verification switched '+old.running_slot+' → '+current.running_slot);
 }
 await install();
 if(process.env.CHROMA_OTA_ROLLBACK==='1'){
  await idle();await page.getByText('Recovery and previous firmware',{exact:true}).click();await page.getByRole('button',{name:'Use previous firmware',exact:true}).click();
  await page.getByText('Firmware boot verified. Refresh this page to load the updated interface.',{exact:true}).waitFor({timeout:180000});const previous=await request('/firmware');assert.equal(previous.running_slot,initial.running_slot);evidence.boots.push({action:'rollback',...previous});assert.deepEqual(await request('/export'),before);console.log('PASS: previous application booted; library preserved');
  await install();
 }
 const expected=await readFile('dist/app.js'),served=Buffer.from(await(await fetch(controller+'/app.js')).arrayBuffer());assert.equal(createHash('sha256').update(served).digest('hex'),createHash('sha256').update(expected).digest('hex'),'Latest UI is embedded in OTA application');
 await page.reload();await page.getByRole('navigation').getByRole('button',{name:'Settings',exact:true}).click();await page.getByLabel('Firmware updates.').count();await page.screenshot({path:'test-results/firmware-installed.png',fullPage:true});assert.deepEqual(errors,[]);evidence.library_preserved=true;evidence.embedded_ui_verified=true;
 console.log('PASS: final package is running, latest embedded UI served, browser errors absent');
}finally{await browser.close();await writeFile('test-results/firmware-hardware.json',JSON.stringify(evidence,null,2)+'\n');}
