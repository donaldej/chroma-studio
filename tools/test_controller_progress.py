"""Live check: resend the current image and verify LCD progress plus tag ACK."""
import argparse
import os
import json
from pathlib import Path
import time

import requests

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--controller', default=os.environ.get('CHROMA_CONTROLLER', 'http://chroma.local'))
parser.add_argument('--serial', required=True)
parser.add_argument('--job-id', help='Observe an already queued job instead of resending')
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
base = args.controller.rstrip('/') + '/api/v1'


def state():
    response = requests.get(base + '/state', timeout=10)
    response.raise_for_status()
    return response.json()


before = state()
assert args.job_id or not any(job['state'] in ('queued', 'sending', 'retrying') for job in before['jobs']), 'Transfer already running'
assert 'lcd_progress_updates' in before['controller'], 'Progress firmware is not installed'
device = next(item for item in before['devices'] if item['serial'] == args.serial)
preset = device.get('last_preset')
assert preset and any(item['id'] == preset for item in before['presets']), 'No saved current screen to resend'
if args.job_id:
    assert any(job['id'] == args.job_id and job['serial'] == args.serial for job in before['jobs']), 'Job does not belong to selected display'
    job_id = args.job_id
else:
    response = requests.post(base + '/jobs', json={'serial': args.serial, 'preset': preset}, timeout=10)
    response.raise_for_status()
    job_id = response.json()['id']
samples = []
progress_values = set()
deadline = time.monotonic() + 330
last = None
try:
    while time.monotonic() < deadline:
        current = state()
        controller = current['controller']
        job = next((item for item in current['jobs'] if item['id'] == job_id), None)
        if job:
            sample = {'state': job['state'], 'progress': job['progress'],
                      'lcd_progress': controller['lcd_transfer_progress'],
                      'lcd_updates': controller['lcd_progress_updates'],
                      'uptime_ms': controller['uptime_ms']}
            samples.append(sample)
            if job['state'] == 'sending' and 0 < sample['lcd_progress'] < 100:
                progress_values.add(sample['lcd_progress'])
            changed = (sample['state'], sample['progress'], sample['lcd_progress'])
            if changed != last:
                print(json.dumps(sample), flush=True)
                last = changed
            if job['state'] not in ('queued', 'sending', 'retrying'):
                assert job['state'] == 'completed', job
                assert job['progress'] == 100, job
                assert len(progress_values) >= 2, 'LCD did not show changing progress during the transfer'
                assert controller['uptime_ms'] > before['controller']['uptime_ms'], 'Controller restarted'
                print('PASS: changing LCD progress and full display acknowledgement', flush=True)
                break
        time.sleep(1.5)
    else:
        raise AssertionError('Transfer did not complete within 330 seconds')
finally:
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps({'job': job_id, 'samples': samples}, indent=2) + '\n', encoding='utf-8')
