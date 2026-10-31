"""Command-line client for Chroma Studio's JSON API."""
import argparse
import os
import json
import time
import requests

parser = argparse.ArgumentParser()
parser.add_argument('--controller', default=os.environ.get('CHROMA_CONTROLLER', 'http://chroma.local'))
commands = parser.add_subparsers(dest='command', required=True)
for name in ('state', 'displays', 'presets', 'jobs'):
    commands.add_parser(name)
send = commands.add_parser('send')
send.add_argument('serial')
send.add_argument('preset')
send.add_argument('--wait', action='store_true', help='Wait for the display acknowledgement')
cancel = commands.add_parser('cancel')
cancel.add_argument('job')
activate = commands.add_parser('activate')
activate.add_argument('serial')
args = parser.parse_args()
paths = {'state': '/state', 'displays': '/displays', 'presets': '/presets', 'jobs': '/jobs',
         'send': '/jobs', 'cancel': '/jobs/cancel', 'activate': '/displays/activate'}
body = {'send': lambda: {'serial': args.serial, 'preset': args.preset},
        'cancel': lambda: {'id': args.job}, 'activate': lambda: {'serial': args.serial}}
response = requests.request('POST' if args.command in body else 'GET',
                            args.controller.rstrip('/') + '/api/v1' + paths[args.command],
                            json=body[args.command]() if args.command in body else None, timeout=12)
result = response.json()
print(json.dumps(result, indent=2))
if not response.ok:
    raise SystemExit(1)
if args.command == 'send' and args.wait:
    deadline = time.monotonic() + 330
    previous = None
    while time.monotonic() < deadline:
        time.sleep(2)
        try:
            response = requests.get(args.controller.rstrip('/') + '/api/v1/jobs', timeout=5)
        except (requests.ConnectionError, requests.Timeout):
            if previous != ('reconnecting', 0):
                print('Reconnecting to controller...', flush=True)
                previous = ('reconnecting', 0)
            continue
        response.raise_for_status()
        job = next((item for item in response.json() if item['id'] == result['id']), None)
        if job is None:
            continue
        progress = (job['state'], job['progress'])
        if progress != previous:
            print(f"{job['state']}: {job['progress']}%" + (f" - {job['error']}" if job['error'] else ''), flush=True)
            previous = progress
        if job['state'] in ('completed', 'failed', 'cancelled'):
            raise SystemExit(0 if job['state'] == 'completed' else 1)
    raise SystemExit('Timed out waiting for the controller; check Activity.')
