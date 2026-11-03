"""Download Studio metadata and all referenced screen files from a controller."""
import argparse
import os
from datetime import datetime
import hashlib
import json
from pathlib import Path
import re

import requests
from library_assets import referenced_assets

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--controller', default=os.environ.get('CHROMA_CONTROLLER', 'http://chroma.local'))
parser.add_argument('--output', type=Path, default=Path('backups') / ('studio-' + datetime.now().strftime('%Y%m%d-%H%M%S')))
args = parser.parse_args()
base = args.controller.rstrip('/') + '/api/v1'
response = requests.get(base + '/export', timeout=15)
response.raise_for_status()
config = response.json()
assets = referenced_assets(config)
jobs_response = requests.get(base + '/jobs', timeout=15)
jobs_response.raise_for_status()
jobs = jobs_response.json()
for job in jobs:
    if job.get('state') in ('queued', 'sending', 'retrying') and job.get('asset') and job['asset'] not in assets:
        assets.append(job['asset'])
if any(not re.fullmatch(r'[A-Za-z0-9_-]{1,32}', asset) for asset in assets):
    raise SystemExit('Controller returned an invalid asset ID; backup stopped.')
args.output.mkdir(parents=True, exist_ok=False)
manifest = {}
for asset in assets:
    response = requests.get(base + '/assets/' + asset, timeout=30)
    response.raise_for_status()
    filename = asset + '.bin'
    (args.output / filename).write_bytes(response.content)
    manifest[filename] = {'bytes': len(response.content), 'sha256': hashlib.sha256(response.content).hexdigest()}
(args.output / 'studio.json').write_text(json.dumps(config, indent=2), encoding='utf-8')
(args.output / 'jobs.json').write_text(json.dumps(jobs, indent=2), encoding='utf-8')
manifest['jobs.json'] = {'bytes': (args.output / 'jobs.json').stat().st_size, 'sha256': hashlib.sha256((args.output / 'jobs.json').read_bytes()).hexdigest()}
(args.output / 'manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
print(f'Backed up metadata and {len(assets)} screen files to {args.output}')
