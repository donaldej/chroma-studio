"""USB recovery: write a Studio application to app0 and reset only the OTA selector.

Preserves NVS/Wi-Fi, the partition table, bootloader and SPIFFS library. A firmware
package (.chroma), filesystem image, and full-flash backup are not valid inputs.
"""
import argparse,struct,subprocess,sys
from pathlib import Path
def validate(data):
 if len(data)<100000 or len(data)>0x640000 or data[0]!=0xe9 or struct.unpack_from('<H',data,12)[0]!=9 or b'CHROMA-STUDIO:T-EMBED-CC1101-PLUS:WEB1:' not in data:
  raise ValueError('Use a standalone Studio 0.5+ ESP32-S3 firmware.bin for this board.')
def recovery_commands(port,firmware):
 base=[sys.executable,'-m','esptool','--chip','esp32s3','--port',port,'--baud','460800']
 return [base+['--after','no_reset','write_flash','0x10000',str(firmware)],base+['--after','hard_reset','erase_region','0xe000','0x2000']]
if __name__=='__main__':
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--port',required=True);parser.add_argument('--firmware',type=Path,required=True);args=parser.parse_args()
 validate(args.firmware.read_bytes())
 for command in recovery_commands(args.port,args.firmware):subprocess.run(command,check=True)
 print('Application restored to app0. OTA selector reset; Wi-Fi and library partitions preserved.')
