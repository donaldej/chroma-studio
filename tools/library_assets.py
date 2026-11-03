"""Find all packet files required by screens, including layout image layers."""
import re


def referenced_assets(config):
    assets = set()
    for entry in config.get('history', []):
        assets.add(entry.get('asset'))
    for device in config.get('devices', []):
        if device.get('last_asset'):
            assets.add(device['last_asset'])
    for preset in config.get('presets', []):
        assets.add(preset.get('asset'))
        for layer in preset.get('elements', []):
            if layer.get('type') == 'image':
                assets.add(layer.get('asset'))
    if any(not isinstance(asset, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,32}', asset) for asset in assets):
        raise ValueError('Library contains an invalid image asset ID.')
    return sorted(assets)
