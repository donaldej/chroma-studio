"""Live OTA rejection/interruption checks. Does not commit or reboot firmware."""
import argparse,json,socket,time
from pathlib import Path
from urllib.parse import urlsplit
import requests
parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--controller',required=True);parser.add_argument('--package',type=Path,required=True);parser.add_argument('--output',type=Path,required=True);args=parser.parse_args()
base=args.controller.rstrip('/');payload=args.package.read_bytes();headers={'X-Chroma-Update':'1'};evidence={}
def get(path):
 response=requests.get(base+'/api/v1'+path,timeout=15);response.raise_for_status();return response.json()
def wait(predicate,timeout=120):
 end=time.monotonic()+timeout
 while time.monotonic()<end:
  if predicate():return
  time.sleep(.5)
 raise AssertionError('Expected controller state was not reached')
def idle():return get('/state')['controller']['radio_mode']=='Idle' and get('/firmware')['status']=='idle'
before=get('/export');slot=get('/firmware')['running_slot'];evidence['running_slot']=slot
assert not any(job['state'] in ('queued','sending','retrying') for job in get('/state')['jobs'])
def reject(name,data,expected,extra_headers=headers):
 wait(idle)
 response=requests.post(base+'/api/v1/firmware/upload',headers=extra_headers,files={'firmware':('test.chroma',data)},timeout=90)
 assert response.status_code>=400,(name,response.text)
 assert expected.lower() in response.text.lower(),(name,response.text)
 assert get('/firmware')['running_slot']==slot and not get('/state')['controller']['updating']
 evidence[name]={'status':response.status_code,'response':response.json()};print('PASS:',name,flush=True)
reject('missing update header',payload,'header',{})
reject('raw firmware rejected',b'not a Chroma package','package')
damaged=bytearray(payload);damaged[-1]^=1
reject('damaged firmware checksum rejected',damaged,'checksum')
wait(idle)
host=urlsplit(base);boundary='chroma-interrupt-test';prefix=(f'--{boundary}\r\nContent-Disposition: form-data; name="firmware"; filename="partial.chroma"\r\nContent-Type: application/octet-stream\r\n\r\n').encode();suffix=(f'\r\n--{boundary}--\r\n').encode()
request_headers=(f'POST /api/v1/firmware/upload HTTP/1.1\r\nHost: {host.netloc}\r\nX-Chroma-Update: 1\r\nContent-Type: multipart/form-data; boundary={boundary}\r\nContent-Length: {len(prefix)+len(payload)+len(suffix)}\r\nConnection: close\r\n\r\n').encode()
connection=socket.create_connection((host.hostname,host.port or 80),timeout=15)
try:
 connection.sendall(request_headers+prefix+payload[:65536]);wait(lambda:get('/firmware')['status']=='uploading' and get('/firmware')['received']>0,30)
 response=requests.post(base+'/api/v1/jobs',json={'serial':'JM00000000B','preset':'none'},timeout=10);assert response.status_code==409 and 'update' in response.text.lower()
 response=requests.post(base+'/wifi',data={'ssid':'test','password':'not-used'},timeout=10);assert response.status_code==409
finally:connection.close()
wait(lambda:not get('/state')['controller']['updating'],30)
assert get('/firmware')['running_slot']==slot
evidence['interrupted upload']={'result':get('/firmware'),'mutations_blocked':True};print('PASS: interrupted upload released update lock; display sends and Wi-Fi changes blocked during upload',flush=True)
after=get('/export');assert before==after,'Library/configuration changed during rejected uploads'
evidence['library_preserved']=True;args.output.parent.mkdir(parents=True,exist_ok=True);args.output.write_text(json.dumps(evidence,indent=2)+'\n')
