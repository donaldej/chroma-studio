"""Explicit live check: retries/restart recovery, schedules and playlist sends.

This creates a temporary, unpaired registry entry for a read-only timeout test.
--reset-check resets the USB controller while that job waits to retry.
Image checks use only the specified real tag and saved presets; no tag firmware
is written. Temporary plans, the fake registry entry, and its history are removed.
"""
import argparse
import json
import os
from pathlib import Path
import time
import uuid

import requests

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--controller', default=os.environ.get('CHROMA_CONTROLLER', 'http://chroma.local'))
parser.add_argument('--serial', required=True)
parser.add_argument('--test-preset', required=True)
parser.add_argument('--final-preset', required=True)
parser.add_argument('--reset-check', action='store_true')
parser.add_argument('--port', default='COM12')
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
base = args.controller.rstrip('/') + '/api/v1'
evidence = {}
plans = []
fake_serial = 'ZZ00000000B'
fake_job = None


def request(path, body=None):
    response = requests.request('GET' if body is None else 'POST', base + path, json=body, timeout=15)
    response.raise_for_status()
    return response.json()


def wait_for(predicate, timeout=330):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        try:
            state = request('/state')
            result = predicate(state)
            if result:
                return state
        except (requests.ConnectionError, requests.Timeout):
            pass
        time.sleep(1.5)
    raise AssertionError('Controller did not reach expected state')


def job_for(state, job_id):
    return next((job for job in state['jobs'] if job['id'] == job_id), {})


def plan_for(state, plan_id):
    return next((plan for plan in state.get('automations', []) if plan['id'] == plan_id), {})


def make_plan(kind, **values):
    plan = {'id': 'check-' + uuid.uuid4().hex[:10], 'name': 'Studio feature self-test', 'kind': kind,
            'serial': args.serial, 'preset': args.test_preset, 'presets': [], 'hour': 9, 'minute': 0,
            'interval_seconds': 300, 'enabled': False, 'next_at': int(time.time()) + 120, **values}
    request('/automations', plan)
    plans.append(plan['id'])
    wait_for(lambda state: plan_for(state, plan['id']))
    return plan


before = request('/state')
assert before['controller']['version'] in ('0.3.0', '0.4.0', '0.5.0')
assert not any(job['state'] in ('queued', 'sending', 'retrying') for job in before['jobs'])
assert any(device['serial'] == args.serial for device in before['devices'])
assert fake_serial not in [device['serial'] for device in before['devices']]
assert all(any(preset['id'] == value for preset in before['presets']) for value in [args.test_preset, args.final_preset])
settings = before['settings'].copy()
try:
    request('/settings', {**settings, 'max_attempts': 2})
    wait_for(lambda state: state['settings']['max_attempts'] == 2)
    invalid = requests.post(base + '/automations', json={'id': 'bad', 'name': 'Bad', 'kind': 'interval',
                            'serial': args.serial, 'preset': args.test_preset, 'interval_seconds': 30}, timeout=10)
    assert invalid.status_code == 400
    for kind in ('daily', 'interval'):
        plan = make_plan(kind)
        saved = plan_for(request('/state'), plan['id'])
        assert saved['enabled'] is False
    print('PASS: paused daily/interval plans and invalid interval rejection', flush=True)

    occupied = {(device['id'], device['channel'], device['network']) for device in before['devices']}
    fake_id = next(value for value in range(65500, 65400, -1) if (value, 0, 1) not in occupied)
    request('/displays', {'serial': fake_serial, 'name': 'Recovery self-test (no tag)', 'id': fake_id,
                         'palette': 'bwy', 'channel': 0, 'network': 1, 'wake_channel': 4})
    wait_for(lambda state: any(device['serial'] == fake_serial for device in state['devices']))
    fake_job = request('/displays/inspect', {'serial': fake_serial, 'query': 'panel'})['id']
    waiting = wait_for(lambda state: job_for(state, fake_job).get('state') == 'retrying', timeout=180)
    assert job_for(waiting, fake_job)['attempts'] == 1
    end = time.monotonic() + 10
    while time.monotonic() < end:
        response = requests.get(args.controller.rstrip('/') + '/jobs.json', timeout=10)
        disk = response.json() if response.ok else []
        if isinstance(disk, list) and any(job['id'] == fake_job and job['state'] == 'retrying' for job in disk):
            break
        time.sleep(.2)
    else:
        raise AssertionError('Retry state was not journaled')
    if args.reset_check:
        import serial
        from esptool.reset import HardReset
        port = serial.Serial(port=None, baudrate=500000, timeout=.2)
        port.dtr = False
        port.rts = False
        port.port = args.port
        with port:
            HardReset(port, uses_usb=True)()
        restored = wait_for(lambda state: state['controller']['uptime_ms'] < waiting['controller']['uptime_ms'] and
                            job_for(state, fake_job).get('state') in ('retrying', 'sending'), timeout=60)
        assert job_for(restored, fake_job)['attempts'] <= 2
        evidence['restart_recovered_job'] = job_for(restored, fake_job)
        print('PASS: retry journal survived a physical controller restart', flush=True)
    failed = wait_for(lambda state: job_for(state, fake_job).get('state') == 'failed', timeout=180)
    assert job_for(failed, fake_job)['attempts'] == 2
    evidence['bounded_retry'] = job_for(failed, fake_job)
    request('/jobs/clear', {'id': fake_job})
    wait_for(lambda state: not job_for(state, fake_job))
    request('/displays/delete', {'serial': fake_serial})
    wait_for(lambda state: all(device['serial'] != fake_serial for device in state['devices']))
    print('PASS: timeout stopped at two attempts and temporary target cleaned up', flush=True)

    current = request('/state')
    if not current['controller']['clock_synced']:
        request('/time', {'epoch': int(time.time())})
        wait_for(lambda state: state['controller']['clock_synced'])
    now = request('/state')['controller']['epoch']
    plan = make_plan('once', enabled=True, next_at=now + 8)
    complete = wait_for(lambda state: plan_for(state, plan['id']).get('last_result') == 'completed', timeout=600)
    evidence['scheduled_send'] = plan_for(complete, plan['id'])
    assert plan_for(complete, plan['id'])['enabled'] is False
    print('PASS: autonomous one-time schedule sent and was acknowledged', flush=True)

    playlist = make_plan('playlist', enabled=True, presets=[args.test_preset, args.final_preset])
    first = wait_for(lambda state: plan_for(state, playlist['id']).get('cursor') == 1 and
                     plan_for(state, playlist['id']).get('last_result') == 'completed', timeout=600)
    first_plan = plan_for(first, playlist['id'])
    assert first_plan['next_at'] >= first['controller']['epoch'] + 290
    evidence['playlist_first'] = first_plan
    request('/automations/toggle', {'id': playlist['id'], 'enabled': True})  # explicit skip of the five-minute wait
    second = wait_for(lambda state: plan_for(state, playlist['id']).get('last_job') != first_plan['last_job'] and
                      plan_for(state, playlist['id']).get('last_result') == 'completed', timeout=600)
    assert plan_for(second, playlist['id'])['cursor'] == 0
    assert next(device for device in second['devices'] if device['serial'] == args.serial)['last_preset'] == args.final_preset
    evidence['playlist_second'] = plan_for(second, playlist['id'])
    request('/automations/toggle', {'id': playlist['id'], 'enabled': False})
    wait_for(lambda state: not plan_for(state, playlist['id'])['enabled'])
    print('PASS: playlist advanced, waited from acknowledgement, wrapped in order, and restored the final screen', flush=True)
finally:
    try:
        current = request('/state')
        for job in current['jobs']:
            if job['state'] in ('queued', 'sending', 'retrying') and (job['serial'] == fake_serial or job.get('source') in plans):
                request('/jobs/cancel', {'id': job['id']})
        wait_for(lambda state: not any(job['state'] in ('queued', 'sending', 'retrying') and
                 (job['serial'] == fake_serial or job.get('source') in plans) for job in state['jobs']), timeout=30)
        if fake_job:
            request('/jobs/clear', {'id': fake_job})
        if any(device['serial'] == fake_serial for device in current['devices']):
            request('/displays/delete', {'serial': fake_serial})
    except requests.RequestException:
        pass
    for plan_id in plans:
        try:
            request('/automations/toggle', {'id': plan_id, 'enabled': False})
            request('/automations/delete', {'id': plan_id})
        except requests.RequestException:
            pass
    try:
        request('/settings', settings)
        evidence['final_state'] = request('/state')
    finally:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(evidence, indent=2) + '\n', encoding='utf-8')
