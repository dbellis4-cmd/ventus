"""Milestone 5 database checks against disposable localhost Supabase only."""
import json
import os
from datetime import datetime, timedelta
from pathlib import Path
import subprocess
import sys
import urllib.error
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor
from zoneinfo import ZoneInfo

root = Path(sys.argv[1]).resolve()
assert root == Path(__file__).resolve().parents[2]
assert not (root / 'supabase/.temp/project-ref').exists(), 'Hosted project linkage is forbidden'
environment = {**os.environ, 'SUPABASE_TELEMETRY_DISABLED': '1', 'XDG_CONFIG_HOME': '/tmp'}
status = json.loads(subprocess.check_output(
    [str(root / 'node_modules/.bin/supabase'), 'status', '-o', 'json'], cwd=root, env=environment, text=True))
base = status['API_URL'].rstrip('/')
assert base.startswith('http://127.0.0.1:')
key = status.get('PUBLISHABLE_KEY') or status['ANON_KEY']
service = status['SERVICE_ROLE_KEY']


def http(path, body=None, token=None, method='POST'):
    assert path.startswith('/') and '://' not in path
    headers = {'apikey': key, 'Content-Type': 'application/json'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    request = urllib.request.Request(base + path, data=json.dumps(body).encode() if body is not None else None,
                                     headers=headers, method=method)
    try:
        response = urllib.request.urlopen(request, timeout=20)
    except urllib.error.HTTPError as error:
        response = error
    payload = response.read().decode()
    return response.status, json.loads(payload) if payload else None


def ok(path, body=None, token=None, method='POST'):
    code, data = http(path, body, token, method)
    assert 200 <= code < 300, (path, code, data.get('code') if isinstance(data, dict) else '',
                              data.get('message') if isinstance(data, dict) else '')
    return data


users = []
anchor = datetime.now(ZoneInfo('America/Phoenix')).date() + timedelta(days=1)
day = lambda offset: (anchor + timedelta(days=offset)).isoformat()

try:
    for _ in range(2):
        email = f'calendar-{uuid.uuid4().hex}@example.test'
        password = uuid.uuid4().hex + '!Aa9'
        user = ok('/auth/v1/admin/users', {'email': email, 'password': password, 'email_confirm': True}, service)
        users.append(user['id'])
        token = ok('/auth/v1/token?grant_type=password', {'email': email, 'password': password})['access_token']
        ok('/rest/v1/rpc/initialize_workspace', {'p_timezone': 'America/Phoenix'}, token)
        if len(users) == 1:
            owner_token = token
            category = ok('/rest/v1/categories?select=id&limit=1', token=token, method='GET')[0]['id']
        else:
            other_token = token

    task = {'title': 'Calendar series', 'category_id': category, 'calendar_opt_in': True,
            'schedule': {'date': day(0), 'timezone': 'America/Phoenix'}}
    series = ok('/rest/v1/rpc/create_recurring_task', {'p_creation_key': str(uuid.uuid4()), 'p_task': task,
                'p_rule': {'frequency': 'daily', 'weekdays': [], 'end_date': None, 'fold_side': 'earlier'}}, owner_token)
    task_id = series['task_id']
    context = ok('/rest/v1/rpc/read_recurrence_context', {'p_task_id': task_id, 'p_key': day(0)}, owner_token)
    ok('/rest/v1/rpc/mutate_recurring_occurrence', {'p_task_id': task_id, 'p_recurrence_key': day(0),
       'p_expected_series_version': context['root_version'], 'p_expected_occurrence_version': 0,
       'p_action': 'edit', 'p_patch': {'calendar_opt_in': False}}, owner_token)
    links = ok('/rest/v1/google_calendar_links?select=recurrence_key,calendar_id,override_opt_in&task_id=eq.' + task_id,
               token=owner_token, method='GET')
    assert links == [{'recurrence_key': day(0), 'calendar_id': None, 'override_opt_in': False}], links
    assert ok('/rest/v1/google_calendar_links?select=id', token=other_token, method='GET') == []
    assert http('/rest/v1/google_calendar_connections?select=*', token=owner_token, method='GET')[0] >= 400

    sync_reads = [
        ('user_settings', 'user_id', 'user_id,timezone,defaults_initialized_at', 'version'),
        ('tasks', 'owner_id', 'id,owner_id,parent_task_id,title,location,calendar_opt_in,recurrence_enabled,deleted_at', 'version'),
        ('task_occurrences', 'owner_id', 'id,owner_id,task_id,recurrence_key,status,deleted_at,scheduled_date,timezone,start_time,starts_at,end_date,end_time,ends_at,definition_snapshot', 'version'),
        ('task_recurrence_revisions', 'owner_id', 'id,owner_id,task_id,effective_from,stopped', 'actor_user_id'),
    ]
    for table, owner_column, columns, private_column in sync_reads:
        path = f'/rest/v1/{table}?select={columns}&{owner_column}=eq.{users[0]}'
        rows = ok(path, token=service, method='GET')
        assert rows, table
        assert ok(path, token=owner_token, method='GET') == rows, table
        assert ok(path, token=other_token, method='GET') == [], table
        assert http(path, method='GET')[0] in (401, 403), table
        assert http(f'/rest/v1/{table}?select={private_column}', token=service, method='GET')[0] == 403, table
    assert http('/rest/v1/tasks?id=eq.' + task_id,
                {'title': 'Unauthorized service write'}, service, 'PATCH')[0] == 403
    assert ok('/rest/v1/tasks?select=title&id=eq.' + task_id, token=owner_token, method='GET')[0]['title'] == 'Calendar series'

    code, _ = http('/rest/v1/rpc/google_calendar_candidates',
                   {'p_owner_id': users[0], 'p_from': day(0), 'p_to': day(6)}, owner_token)
    assert code >= 400, code
    candidates = ok('/rest/v1/rpc/google_calendar_candidates',
                    {'p_owner_id': users[0], 'p_from': day(0), 'p_to': day(10)}, service)
    assert len([row for row in candidates if row['task_id'] == task_id]) == 11
    assert ok('/rest/v1/rpc/google_calendar_candidates',
              {'p_owner_id': users[1], 'p_from': day(0), 'p_to': day(6)}, service) == []
    context = ok('/rest/v1/rpc/read_recurrence_context', {'p_task_id': task_id, 'p_key': day(2)}, owner_token)
    series_change = {'p_task_id': task_id,
       'p_expected_series_version': context['root_version'], 'p_from_date': day(2), 'p_stop': False,
       'p_rule': {'frequency': 'daily', 'weekdays': [], 'end_date': None, 'fold_side': 'earlier'},
       'p_schedule': {'date': day(2), 'timezone': 'America/Phoenix'}, 'p_title': 'Calendar series',
       'p_category_id': category, 'p_calendar_opt_in': False}
    assert http('/rest/v1/rpc/change_recurring_series', series_change, other_token)[0] >= 400
    ok('/rest/v1/rpc/change_recurring_series', series_change, owner_token)
    changed = ok('/rest/v1/rpc/google_calendar_candidates',
                 {'p_owner_id': users[0], 'p_from': day(2), 'p_to': day(3)}, service)
    assert all(row['definition_snapshot']['calendar_opt_in'] is False for row in changed if row['task_id'] == task_id)

    ok('/rest/v1/google_calendar_connections', {'owner_id': users[0], 'status': 'connected',
       'google_sub': 'fixture-google-sub',
       'calendar_id': 'fake-local-calendar', 'refresh_token_ciphertext': 'fake-encrypted-token'}, service)

    one = ok('/rest/v1/rpc/create_task', {'p_creation_key': str(uuid.uuid4()), 'p_task':
             {'title': 'One-time meeting', 'category_id': category, 'calendar_opt_in': True,
              'schedule': {'date': day(0), 'timezone': 'America/Phoenix'}}}, owner_token)
    one_id = one['task_id']
    dirty = ok('/rest/v1/google_calendar_dirty?select=task_id&task_id=eq.' + one_id,
               token=service, method='GET')
    assert dirty == [{'task_id': one_id}], dirty
    assert users[0] in ok('/rest/v1/rpc/google_calendar_due_owners', {'p_limit': 10}, service)
    assert http('/rest/v1/rpc/google_calendar_due_owners', {'p_limit': 10}, owner_token)[0] >= 400
    ok('/rest/v1/google_calendar_links', {'owner_id': users[0], 'task_id': one_id, 'recurrence_key': 'once',
       'calendar_id': 'fake-local-calendar', 'override_opt_in': False, 'state': 'suppressed'}, service)
    definition = ok('/rest/v1/tasks?select=version&id=eq.' + one_id, token=owner_token, method='GET')[0]
    occurrence = ok('/rest/v1/task_occurrences?select=version&task_id=eq.' + one_id, token=owner_token, method='GET')[0]
    ok('/rest/v1/rpc/edit_task_tree', {'p_root_task_id': one_id,
       'p_expected_root_version': definition['version'], 'p_edits': [{
           'task_id': one_id, 'task_version': definition['version'],
           'occurrence_version': occurrence['version'], 'patch': {'calendar_opt_in': True}}]}, owner_token)
    link = ok('/rest/v1/google_calendar_links?select=override_opt_in,state&task_id=eq.' + one_id,
              token=owner_token, method='GET')[0]
    assert link == {'override_opt_in': None, 'state': 'absent'}, link
    duplicate = {'owner_id': users[1], 'status': 'connected', 'google_sub': 'fixture-google-sub',
                 'calendar_id': 'other-calendar', 'refresh_token_ciphertext': 'other-fake-token'}
    assert http('/rest/v1/google_calendar_connections', duplicate, service)[0] == 409
    original = ok('/rest/v1/google_calendar_connections?select=owner_id,status,calendar_id,refresh_token_ciphertext'
                  '&google_sub=eq.fixture-google-sub', token=service, method='GET')
    assert original == [{'owner_id': users[0], 'status': 'connected', 'calendar_id': 'fake-local-calendar',
                         'refresh_token_ciphertext': 'fake-encrypted-token'}], original
    assert http('/rest/v1/google_calendar_connections', duplicate, other_token)[0] >= 400
    assert http('/rest/v1/google_calendar_connections', {**duplicate, 'google_sub': None}, service)[0] == 400

    def disconnect(user_id):
        return http('/rest/v1/google_calendar_connections?owner_id=eq.' + user_id,
                    {'status': 'disconnected', 'google_sub': None, 'refresh_token_ciphertext': None}, service, 'PATCH')

    assert http('/rest/v1/google_calendar_connections?owner_id=eq.' + users[0],
                {'status': 'disconnecting', 'refresh_token_ciphertext': None}, service, 'PATCH')[0] < 300
    assert http('/rest/v1/google_calendar_connections', duplicate, service)[0] == 409
    assert disconnect(users[0])[0] < 300
    assert http('/rest/v1/google_calendar_connections?owner_id=eq.' + users[0],
                token=service, method='DELETE')[0] < 300
    attempts = [
        {'owner_id': users[0], 'status': 'connected', 'google_sub': 'race-google-sub',
         'calendar_id': 'race-calendar-a', 'refresh_token_ciphertext': 'race-token-a'},
        {'owner_id': users[1], 'status': 'connected', 'google_sub': 'race-google-sub',
         'calendar_id': 'race-calendar-b', 'refresh_token_ciphertext': 'race-token-b'},
    ]
    def claim(attempt):
        return http('/rest/v1/google_calendar_connections', attempt, service)
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(claim, attempts))
    assert sorted(code for code, _ in results) == [201, 409], results
    winner = ok('/rest/v1/google_calendar_connections?select=owner_id&google_sub=eq.race-google-sub',
                token=service, method='GET')
    assert len(winner) == 1
    loser = next(attempt for attempt in attempts if attempt['owner_id'] != winner[0]['owner_id'])
    assert disconnect(winner[0]['owner_id'])[0] < 300
    assert claim(loser)[0] == 201
    assert ok('/rest/v1/google_calendar_connections?select=owner_id&google_sub=eq.race-google-sub',
              token=service, method='GET') == [{'owner_id': loser['owner_id']}]
    print('PASS: local migration, narrow service reads, denied writes, owner isolation, calendar preferences, uniqueness race, reconnect')
finally:
    for user_id in users:
        http('/auth/v1/admin/users/' + user_id, token=service, method='DELETE')
