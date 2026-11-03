"""Live Studio 0.4 test: radio counters, immutable image resend and visual checks.

Resends the selected saved screen twice. Temporarily points its preset metadata
at another existing image, verifies history retains the original, then restores
the original metadata. The physical screen ends with the selected saved image.
"""
import argparse
import json
from pathlib import Path
import time
import requests

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--controller',required=True)
parser.add_argument('--serial',required=True)
parser.add_argument('--preset',required=True)
parser.add_argument('--alternate-preset',required=True)
parser.add_argument('--output',type=Path,required=True)
args=parser.parse_args();base=args.controller.rstrip('/')+'/api/v1'
def request(path,body=None):
 response=requests.request('GET' if body is None else 'POST',base+path,json=body,timeout=15)
 response.raise_for_status();return response.json()
def wait(predicate,timeout=600):
 end=time.monotonic()+timeout
 while time.monotonic()<end:
  state=request('/state')
  if predicate(state):return state
  time.sleep(2)
 raise AssertionError('Expected state not reached')
def device(state):return next(item for item in state['devices'] if item['serial']==args.serial)
def job(state,id):return next((item for item in state['jobs'] if item['id']==id),{})
before=request('/state');assert before['controller']['version'] in ('0.4.0','0.5.0')
assert not any(item['state'] in ('queued','sending','retrying') for item in before['jobs'])
original=next(item for item in before['presets'] if item['id']==args.preset)
alternate=next(item for item in before['presets'] if item['id']==args.alternate_preset)
assert original['asset']!=alternate['asset']
evidence={'before':before};first_id=None
try:
 first_id=request('/jobs',{'serial':args.serial,'preset':args.preset})['id']
 first=wait(lambda state:job(state,first_id).get('state') in ('completed','failed'))
 assert job(first,first_id)['state']=='completed',job(first,first_id)
 entry=next(item for item in first['history'] if item['id']==first_id)
 assert entry['asset']==original['asset'] and entry['attempts']>=1 and entry['duration_ms']>0
 evidence['first_send']=job(first,first_id);print('PASS: acknowledged image snapshot and persistent radio measurements',flush=True)
 request('/displays/confirm',{'serial':args.serial,'image_id':first_id,'confirmed':True})
 wait(lambda state:next(item for item in state['history'] if item['id']==first_id)['confirmed'])
 request('/presets',{**original,'asset':alternate['asset']})
 wait(lambda state:next(item for item in state['presets'] if item['id']==args.preset)['asset']==alternate['asset'])
 # Cross at least one periodic asset-GC pass while the old packet is historical.
 time.sleep(65)
 asset=requests.get(base+'/assets/'+original['asset'],timeout=15);asset.raise_for_status()
 second_id=request('/history/resend',{'id':first_id})['id']
 queued=wait(lambda state:bool(job(state,second_id)),timeout=30)
 assert job(queued,second_id)['asset']==original['asset']
 request('/presets',original)
 wait(lambda state:next(item for item in state['presets'] if item['id']==args.preset)['asset']==original['asset'])
 final=wait(lambda state:job(state,second_id).get('state') in ('completed','failed'))
 assert job(final,second_id)['state']=='completed',job(final,second_id)
 assert device(final)['last_image_id']==second_id and device(final)['visual_confirmed'] is False
 assert next(item for item in final['history'] if item['id']==first_id)['confirmed'] is True
 stats=device(final)['radio_stats'];assert stats['acknowledged']>=2 and stats['attempts']>=stats['acknowledged']
 evidence['history_resend']=job(final,second_id);evidence['final']=final
 print('PASS: historical asset survived cleanup and resent after template edit; new visual confirmation cleared; original preset restored',flush=True)
 read_id=request('/displays/inspect',{'serial':args.serial,'query':'panel','source':'probe'})['id']
 checked=wait(lambda state:job(state,read_id).get('state') in ('completed','failed'))
 assert job(checked,read_id)['state']=='completed',job(checked,read_id)
 assert device(checked)['last_image_id']==second_id
 evidence['read_only_probe']=job(checked,read_id);evidence['final']=checked
 print('PASS: read-only connection probe acknowledged without changing image history',flush=True)
finally:
 # Synthetic confirmation is test data, not an observation of the physical panel.
 if first_id:
  current=request('/state')
  if device(current).get('last_image_id')==first_id:
   request('/displays/confirm',{'serial':args.serial,'image_id':first_id,'confirmed':False})
  else:
   request('/history/clear',{'id':first_id})
 request('/presets',original)
 wait(lambda state:next(item for item in state['presets'] if item['id']==args.preset)['asset']==original['asset'])
 args.output.parent.mkdir(parents=True,exist_ok=True)
 args.output.write_text(json.dumps(evidence,indent=2)+'\n',encoding='utf-8')
