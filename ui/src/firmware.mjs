import {sha256} from '@noble/hashes/sha256';
import {bytesToHex} from '@noble/hashes/utils';
export function inspectFirmware(bytes,maxBytes=0x640000){
 if(bytes.length<12||new TextDecoder().decode(bytes.subarray(0,8))!=='CHROMA5\n')throw new Error('Choose a Chroma Studio .chroma package, not a raw .bin or full-flash backup.');
 const size=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint32(8,true);
 if(size<1||size>1024||bytes.length<12+size)throw new Error('Invalid firmware manifest.');
 let manifest;try{manifest=JSON.parse(new TextDecoder().decode(bytes.subarray(12,12+size)));}catch{throw new Error('Invalid firmware manifest.');}
 if(manifest.format!==1||manifest.board!=='lilygo-t-embed-cc1101-plus'||manifest.embedded_web!==true||!/^[A-Za-z0-9._-]{1,32}$/.test(manifest.version||''))throw new Error('This package is incompatible with the T-Embed CC1101 Plus.');
 const app=bytes.subarray(12+size);
 if(!Number.isInteger(manifest.bytes)||manifest.bytes<100000||manifest.bytes>maxBytes||app.length!==manifest.bytes)throw new Error('Firmware is incomplete or exceeds the inactive slot size.');
 if(app[0]!==0xe9||app[12]!==9||app[13]!==0)throw new Error('Package does not contain an ESP32-S3 application.');
 if(bytesToHex(sha256(app))!==manifest.sha256)throw new Error('Firmware checksum mismatch.');
 const marker='CHROMA-STUDIO:T-EMBED-CC1101-PLUS:WEB1:'+manifest.version+'\0';
 if(!new TextDecoder('latin1').decode(app).includes(marker))throw new Error('Firmware board/version marker is missing.');
 return manifest;
}
