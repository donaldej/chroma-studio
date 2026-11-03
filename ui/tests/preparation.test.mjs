import {test} from 'node:test';
import assert from 'node:assert/strict';
import {quantizeImage} from '../src/image-prep.mjs';
import {inspectFirmware} from '../src/firmware.mjs';
import {sha256} from '@noble/hashes/sha256';
import {bytesToHex} from '@noble/hashes/utils';
const packageFor=(changes={},appChanges=()=>{})=>{
 const app=new Uint8Array(100000);app[0]=0xe9;app[12]=9;app.set(new TextEncoder().encode('CHROMA-STUDIO:T-EMBED-CC1101-PLUS:WEB1:0.5.0\0'),500);appChanges(app);
 const manifest={format:1,board:'lilygo-t-embed-cc1101-plus',embedded_web:true,version:'0.5.0',bytes:app.length,sha256:bytesToHex(sha256(app)),...changes};
 const json=new TextEncoder().encode(JSON.stringify(manifest)),bytes=new Uint8Array(12+json.length+app.length);bytes.set(new TextEncoder().encode('CHROMA5\n'));new DataView(bytes.buffer).setUint32(8,json.length,true);bytes.set(json,12);bytes.set(app,12+json.length);return bytes;
};
test('image preparation preserves transparency and pigment colors; mono clears accent',()=>{
 const rgba=new Uint8ClampedArray([0,0,0,0,230,187,57,255,23,27,25,255,255,255,255,255]);
 const color=quantizeImage(rgba,4,1);assert.deepEqual([...color.slice(0,4)],[255,255,255,255]);assert.deepEqual([...color.slice(4,8)],[230,187,57,255]);
 const mono=quantizeImage(rgba,4,1,{palette:'mono'});for(let i=0;i<mono.length;i+=4)assert(mono[i]===23||mono[i]===255);
});
test('photo dithering reproduces midtone coverage without yellow fringes',()=>{
 const rgba=new Uint8ClampedArray(64*64*4);for(let i=0;i<rgba.length;i+=4)rgba.set([128,128,128,255],i);
 for(const dither of ['floyd','ordered']){const result=quantizeImage(rgba,64,64,{dither});let black=0;for(let i=0;i<result.length;i+=4){assert(result[i]===23||result[i]===255);black+=result[i]===23?1:0;}assert(black>1200&&black<2800,dither+' preserves a useful gray density');}
 const bright=quantizeImage(rgba,64,64,{brightness:100});assert.equal(bright[0],255);const dark=quantizeImage(rgba,64,64,{brightness:-100});assert.equal(dark[0],23);
});
test('firmware preflight verifies format, target, chip, exact length, hash and embedded web version',()=>{
 const valid=packageFor();assert.equal(inspectFirmware(valid).version,'0.5.0');
 assert.throws(()=>inspectFirmware(valid.subarray(0,-1)),/incomplete/);
 assert.throws(()=>inspectFirmware(packageFor({board:'other'})),/incompatible/);
 assert.throws(()=>inspectFirmware(packageFor({},app=>app[12]=0)),/ESP32-S3/);
 assert.throws(()=>inspectFirmware(packageFor({sha256:'0'.repeat(64)})),/checksum/);
 assert.throws(()=>inspectFirmware(packageFor({version:'0.5.1'})),/marker/);
 assert.throws(()=>inspectFirmware(valid,99999),/exceeds/);
 valid[0]=0;assert.throws(()=>inspectFirmware(valid),/package/);
});
