"""Create a browser-installable Chroma Studio firmware package (application + embedded UI)."""
import argparse,hashlib,json,re,struct
from pathlib import Path
MAGIC=b'CHROMA5\n'
TARGET=b'CHROMA-STUDIO:T-EMBED-CC1101-PLUS:WEB1:'
def package_firmware(data,version):
 if len(data)<100000 or len(data)>0x640000 or data[0]!=0xe9 or struct.unpack_from('<H',data,12)[0]!=9:
  raise ValueError('Expected a standalone ESP32-S3 application for an OTA slot, not a filesystem or full-flash image.')
 if not re.fullmatch(r'[A-Za-z0-9._-]{1,32}',version) or TARGET+version.encode()+b'\0' not in data:
  raise ValueError('Application lacks the matching Chroma Studio board/version/embedded-web marker.')
 manifest={'format':1,'board':'lilygo-t-embed-cc1101-plus','version':version,'embedded_web':True,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()}
 header=json.dumps(manifest,separators=(',',':')).encode()
 return MAGIC+struct.pack('<I',len(header))+header+data,manifest
if __name__=='__main__':
 parser=argparse.ArgumentParser(description=__doc__)
 parser.add_argument('firmware',type=Path)
 parser.add_argument('--output',type=Path,required=True)
 parser.add_argument('--version',help='Defaults to firmware/RFV3/firmware_update.h')
 args=parser.parse_args()
 version=args.version or re.search(r'#define STUDIO_VERSION "([^"]+)"',(Path(__file__).resolve().parents[1]/'firmware/RFV3/firmware_update.h').read_text()).group(1)
 payload,manifest=package_firmware(args.firmware.read_bytes(),version)
 args.output.parent.mkdir(parents=True,exist_ok=True);args.output.write_bytes(payload)
 args.output.with_suffix('.json').write_text(json.dumps(manifest,indent=2)+'\n')
 print(f'Packaged Studio {version}: {len(payload)} bytes, SHA-256 {manifest["sha256"]}')
