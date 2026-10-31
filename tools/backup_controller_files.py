"""Save the old controller filesystem before replacing its interface."""
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import requests

root = Path(__file__).resolve().parents[1] / 'backups' / 'pre-studio'
root.mkdir(parents=True, exist_ok=True)
session = requests.Session()
session.auth = ('admin', 'admin')
base = os.environ.get('CHROMA_CONTROLLER', 'http://chroma.local')
response = session.get(base + '/edit', params={'list': '/'}, timeout=15)
response.raise_for_status()
listing = response.json()
saved = []
for item in listing:
    if item.get('type') != 'file':
        continue
    name = item['name'].lstrip('/')
    if '/' in name or '\\' in name or name in ('', '.', '..'):
        continue
    result = session.get(base + '/' + name, timeout=15)
    result.raise_for_status()
    (root / name).write_bytes(result.content)
    saved.append({'name': name, 'bytes': len(result.content)})
(root / 'manifest.json').write_text(json.dumps({'created_utc': datetime.now(timezone.utc).isoformat(), 'files': saved}, indent=2))
print(f'Preserved {len(saved)} controller files in backups/pre-studio.')
