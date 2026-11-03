"""Temporarily include a verified Studio backup in a filesystem build."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
from library_assets import referenced_assets

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('backup', type=Path)
parser.add_argument('--clean', action='store_true', help='Remove only matching temporary copies after building')
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
target = (root / 'firmware/data').resolve()
if not target.is_relative_to(root):
    raise SystemExit('Firmware data directory is outside the workspace.')
config = json.loads((args.backup / 'studio.json').read_text(encoding='utf-8'))
manifest = json.loads((args.backup / 'manifest.json').read_text(encoding='utf-8'))
plans = [(args.backup / 'studio.json', target / 'studio.json')]
jobs_path = args.backup / 'jobs.json'
if jobs_path.exists():
    jobs = json.loads(jobs_path.read_text(encoding='utf-8'))
    if any(job.get('state') in ('queued', 'sending', 'retrying') for job in jobs):
        raise SystemExit('Finish or cancel pending transfers and make a fresh backup before replacing the filesystem.')
    if hashlib.sha256(jobs_path.read_bytes()).hexdigest() != manifest.get('jobs.json', {}).get('sha256'):
        raise SystemExit('Job history checksum mismatch.')
    plans.append((jobs_path, target / 'jobs.json'))
for asset in referenced_assets(config):
    if not isinstance(asset, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,32}', asset):
        raise SystemExit('Invalid asset ID in backup.')
    source = args.backup / (asset + '.bin')
    if hashlib.sha256(source.read_bytes()).hexdigest() != manifest[source.name]['sha256']:
        raise SystemExit('Backup checksum mismatch: ' + source.name)
    plans.append((source, target / ('screen-' + asset + '.bin')))
for source, destination in plans:
    if destination.resolve().parent != target:
        raise SystemExit('Unsafe destination path.')
    if destination.exists():
        if not args.clean:
            raise SystemExit('Destination already exists: ' + destination.name)
        if hashlib.sha256(destination.read_bytes()).digest() != hashlib.sha256(source.read_bytes()).digest():
            raise SystemExit('Staged file was modified; leaving files intact: ' + destination.name)
for source, destination in plans:
    if args.clean:
        if destination.exists():
            destination.unlink()
    else:
        shutil.copy2(source, destination)
print(('Cleaned' if args.clean else 'Staged') + f' {len(plans)} verified library files.')
