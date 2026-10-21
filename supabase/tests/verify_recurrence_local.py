"""Small localhost-only smoke test for the Milestone 4 authenticated RPC contract."""
from concurrent.futures import ThreadPoolExecutor
import json
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
import subprocess
import shutil
from pathlib import Path
import sys
import urllib.error
import urllib.request
import uuid

root = Path(sys.argv[1]).resolve()
assert root.parent == Path('/private/tmp') and root.name.startswith('ventus-m3-local-')
assert not (root / 'supabase/.temp/project-ref').exists(), 'Linked project forbidden'
status = json.loads(subprocess.check_output(['./node_modules/.bin/supabase', 'status', '--workdir', str(root), '-o', 'json'], text=True))
base = status['API_URL'].rstrip('/')
assert base.startswith('http://127.0.0.1:')
key = status.get('PUBLISHABLE_KEY') or status['ANON_KEY']
service = status['SERVICE_ROLE_KEY']
docker = shutil.which('docker') or '/Applications/Docker.app/Contents/Resources/bin/docker'
calendar_checks = subprocess.check_output([docker, 'exec', '-i', 'supabase_db_' + root.name,
    'psql', '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres',
    '-c', "select ventus_private.recurrence_matches('monthly','2026-01-31','2026-02-28','{}'),"
          "ventus_private.recurrence_matches('monthly','2026-01-31','2026-03-31','{}'),"
          "ventus_private.recurrence_matches('yearly','2028-02-29','2029-02-28','{}'),"
          "ventus_private.recurrence_matches('yearly','2028-02-29','2032-02-29','{}'),"
          "ventus_private.recurrence_instant('2026-03-08','02:30','America/New_York','earlier'),"
          "ventus_private.recurrence_instant('2026-11-01','01:30','America/New_York','earlier'),"
          "ventus_private.recurrence_instant('2026-11-01','01:30','America/New_York','later');"], text=True).strip()
assert calendar_checks == 'f|t|f|t||2026-11-01 05:30:00+00|2026-11-01 06:30:00+00'


def http(path, body=None, token=None, admin=False, method='POST'):
    headers = {'apikey': key, 'Content-Type': 'application/json'}
    if token or admin:
        headers['Authorization'] = 'Bearer ' + (service if admin else token)
    request = urllib.request.Request(base + path, data=json.dumps(body).encode() if body is not None else None,
                                     headers=headers, method=method)
    try:
        response = urllib.request.urlopen(request, timeout=20)
    except urllib.error.HTTPError as error:
        response = error
    payload = json.loads(response.read().decode() or 'null')
    return response.status, payload


def ok(path, body=None, token=None, admin=False, method='POST'):
    code, payload = http(path, body, token, admin, method)
    if not 200 <= code < 300:
        raise AssertionError(f'{path}: HTTP {code}, {payload.get("code")}, {payload.get("message")}')
    return payload



anchor = datetime.now(ZoneInfo('America/Phoenix')).date() + timedelta(days=1)
def day(offset):
    return (anchor + timedelta(days=offset)).isoformat()


email = 'recurrence-' + uuid.uuid4().hex + '@example.test'
password = uuid.uuid4().hex + '!Aa9'
user = ok('/auth/v1/admin/users', {'email': email, 'password': password, 'email_confirm': True}, admin=True)
try:
    token = ok('/auth/v1/token?grant_type=password', {'email': email, 'password': password})['access_token']
    ok('/rest/v1/rpc/initialize_workspace', {'p_timezone': 'America/Phoenix'}, token)
    category = ok('/rest/v1/categories?select=id&limit=1', token=token, method='GET')[0]['id']
    task = {'title': 'Recurring smoke', 'category_id': category,
            'schedule': {'date': day(0), 'timezone': 'America/Phoenix'},
            'subtasks': [{'title': 'Child', 'category_id': category,
                          'schedule': {'date': day(1), 'timezone': 'America/Phoenix'}}]}
    rule = {'frequency': 'daily', 'weekdays': [], 'end_date': None, 'fold_side': 'earlier'}
    creation_key = str(uuid.uuid4())
    created = ok('/rest/v1/rpc/create_recurring_task',
                 {'p_creation_key': creation_key, 'p_task': task, 'p_rule': rule}, token)
    task_id = created['task_id']
    candidates = ok('/rest/v1/rpc/list_recurrence_candidates',
                    {'p_from': day(0), 'p_to': day(6)}, token)
    assert len(candidates) == 13
    parent = next(row for row in candidates if row['task_id'] == task_id)
    context = ok('/rest/v1/rpc/read_recurrence_context',
                 {'p_task_id': task_id, 'p_key': parent['recurrence_key']}, token)
    assert context['root_version'] > 0 and len(context['nodes']) == 2, context
    assert ok('/rest/v1/task_occurrences?select=id', token=token, method='GET') == []
    repeated = ok('/rest/v1/rpc/create_recurring_task',
                  {'p_creation_key': creation_key, 'p_task': task, 'p_rule': rule}, token)
    assert repeated['task_id'] == task_id and repeated['created'] is False
    result = ok('/rest/v1/rpc/mutate_recurring_occurrence',
                {'p_task_id': task_id, 'p_recurrence_key': day(0),
                 'p_expected_series_version': context['root_version'],
                 'p_expected_occurrence_version': 0, 'p_action': 'complete'}, token)
    assert result['version'] > 0
    assert len(ok('/rest/v1/task_activity?select=id', token=token, method='GET')) == 1
    duplicate, duplicate_body = http('/rest/v1/rpc/mutate_recurring_occurrence',
        {'p_task_id': task_id, 'p_recurrence_key': day(0),
         'p_expected_series_version': context['root_version'],
         'p_expected_occurrence_version': 0, 'p_action': 'complete'}, token)
    assert duplicate >= 400 and duplicate_body['code'] == '40001'
    forged, forged_body = http('/rest/v1/rpc/mutate_recurring_occurrence',
        {'p_task_id': task_id, 'p_recurrence_key': day(-1),
         'p_expected_series_version': context['root_version'],
         'p_expected_occurrence_version': 0, 'p_action': 'complete'}, token)
    assert forged >= 400 and forged_body['code'] == 'P0002'
    edited = ok('/rest/v1/rpc/mutate_recurring_occurrence',
        {'p_task_id': task_id, 'p_recurrence_key': day(1),
         'p_expected_series_version': context['root_version'],
         'p_expected_occurrence_version': 0, 'p_action': 'edit',
         'p_patch': {'title': 'Special Wednesday'}}, token)
    assert edited['version'] > 0
    postponed = ok('/rest/v1/rpc/mutate_recurring_occurrence',
        {'p_task_id': task_id, 'p_recurrence_key': day(1),
         'p_expected_series_version': context['root_version'],
         'p_expected_occurrence_version': edited['version'], 'p_action': 'postpone',
         'p_schedule': {'date': day(3), 'timezone': 'America/Phoenix'}}, token)
    assert postponed['version'] > edited['version']
    stopped = ok('/rest/v1/rpc/change_recurring_series',
                 {'p_task_id': task_id, 'p_expected_series_version': context['root_version'],
                  'p_from_date': day(2), 'p_stop': True}, token)
    assert stopped['series_version'] > context['root_version']
    after = ok('/rest/v1/rpc/list_recurrence_candidates',
               {'p_from': day(0), 'p_to': day(6)}, token)
    assert len(after) == 3 and all(row['recurrence_key'] < day(2) for row in after)
    changed = ok('/rest/v1/task_occurrences?select=recurrence_key,original_date,scheduled_date,status&task_id=eq.' + task_id,
                 token=token, method='GET')
    assert len(changed) == 2 and any(row['original_date'] == day(1) and
                                     row['scheduled_date'] == day(3) for row in changed)
    hidden, hidden_body = http('/rest/v1/rpc/mutate_recurring_occurrence',
        {'p_task_id': task_id, 'p_recurrence_key': day(1),
         'p_expected_series_version': stopped['series_version'],
         'p_expected_occurrence_version': postponed['version'], 'p_action': 'complete'}, token)
    assert hidden >= 400 and hidden_body['code'] == 'P0002'
    ok('/rest/v1/rpc/mutate_recurring_occurrence',
       {'p_task_id': task_id, 'p_recurrence_key': day(0),
        'p_expected_series_version': stopped['series_version'],
        'p_expected_occurrence_version': result['version'], 'p_action': 'delete'}, token)
    after_parent_delete = ok('/rest/v1/rpc/list_recurrence_candidates',
                             {'p_from': day(0), 'p_to': day(6)}, token)
    assert not any(row['parent_task_id'] == task_id and row['recurrence_key'] == day(0)
                   for row in after_parent_delete)
    once = ok('/rest/v1/rpc/create_task',
              {'p_creation_key': str(uuid.uuid4()),
               'p_task': {'title': 'Convert me', 'category_id': category,
                          'schedule': {'date': day(0), 'timezone': 'America/Phoenix'}}}, token)
    once_id = once['task_id']
    before_task = ok('/rest/v1/tasks?select=version&id=eq.' + once_id, token=token, method='GET')[0]
    before_occ = ok('/rest/v1/task_occurrences?select=id,version&task_id=eq.' + once_id,
                    token=token, method='GET')[0]
    ok('/rest/v1/rpc/edit_task_tree', {'p_root_task_id': once_id,
       'p_expected_root_version': before_task['version'],
       'p_edits': [{'task_id': once_id, 'task_version': before_task['version'],
                   'occurrence_version': before_occ['version'],
                   'patch': {'title': 'Edited before conversion'}}],
       'p_new_subtasks': [{'parent_task_id': once_id,
                           'task': {'title': 'Existing child', 'category_id': category,
                                    'schedule': {'date': day(1), 'timezone': 'America/Phoenix'}}}]}, token)
    existing_child = ok('/rest/v1/tasks?select=id&parent_task_id=eq.' + once_id,
                        token=token, method='GET')[0]['id']
    before_task = ok('/rest/v1/tasks?select=version&id=eq.' + once_id, token=token, method='GET')[0]
    before_occ = ok('/rest/v1/task_occurrences?select=id,version&task_id=eq.' + once_id,
                    token=token, method='GET')[0]
    def stored_rows(table, fields):
        return ok('/rest/v1/' + table + '?select=' + fields + '&order=id',
                  token=token, method='GET')
    before_rollback = [stored_rows('tasks', 'id,version,title'),
                       stored_rows('task_occurrences', 'id,version'),
                       stored_rows('task_activity', 'id')]
    rolled_back, rollback_body = http('/rest/v1/rpc/edit_task_tree', {
        'p_root_task_id': once_id, 'p_expected_root_version': before_task['version'],
        'p_edits': [{'task_id': once_id, 'task_version': before_task['version'],
                     'occurrence_version': before_occ['version'],
                     'patch': {'title': 'Must roll back'}}],
        'p_new_subtasks': [
            {'parent_task_id': once_id, 'task': {'title': 'Must roll back too',
                'category_id': category, 'schedule': {'date': day(1), 'timezone': 'America/Phoenix'}}},
            {'parent_task_id': once_id, 'task': {'title': 'Invalid category',
                'category_id': str(uuid.uuid4()),
                'schedule': {'date': day(1), 'timezone': 'America/Phoenix'}}}]}, token)
    assert rolled_back >= 400 and rollback_body['code'] == 'P0002'
    assert before_rollback == [stored_rows('tasks', 'id,version,title'),
                               stored_rows('task_occurrences', 'id,version'),
                               stored_rows('task_activity', 'id')]
    converted = ok('/rest/v1/rpc/convert_task_to_series',
                   {'p_task_id': once_id, 'p_expected_task_version': before_task['version'],
                    'p_expected_occurrence_version': before_occ['version'], 'p_rule': rule}, token)
    assert ok('/rest/v1/task_occurrences?select=id&task_id=eq.' + once_id,
              token=token, method='GET')[0]['id'] == before_occ['id']
    assert any(row['task_id'] == existing_child and row['recurrence_key'] == day(1) for row in
               ok('/rest/v1/rpc/list_recurrence_candidates',
                  {'p_from': day(2), 'p_to': day(2)}, token))
    old_rpc, old_body = http('/rest/v1/rpc/set_task_completion',
        {'p_task_id': once_id, 'p_expected_task_version': converted['task_version'],
         'p_expected_occurrence_version': before_occ['version'], 'p_completed': True}, token)
    assert old_rpc >= 400 and old_body['code'] == '0A000'
    legacy_add = {'p_root_task_id': once_id,
                  'p_expected_root_version': converted['task_version'],
                  'p_edits': [], 'p_delete_subtasks': [],
                  'p_new_subtasks': [{'parent_task_id': once_id,
                      'task': {'title': 'Forbidden one-time child', 'category_id': category,
                               'schedule': {'date': day(2), 'timezone': 'America/Phoenix'}}}]}
    before_rejection = [stored_rows('tasks', 'id,version,title'),
                        stored_rows('task_occurrences', 'id,version'),
                        stored_rows('task_activity', 'id')]
    denied_add, denied_body = http('/rest/v1/rpc/edit_task_tree', legacy_add, token)
    assert denied_add >= 400 and denied_body['code'] == '0A000'
    assert before_rejection == [stored_rows('tasks', 'id,version,title'),
                                stored_rows('task_occurrences', 'id,version'),
                                stored_rows('task_activity', 'id')]
    changed_future = ok('/rest/v1/rpc/mutate_recurring_occurrence',
        {'p_task_id': once_id, 'p_recurrence_key': day(3),
         'p_expected_series_version': converted['task_version'],
         'p_expected_occurrence_version': 0, 'p_action': 'edit',
         'p_patch': {'title': 'Keep this exception'}}, token)
    concurrent_add = {**legacy_add, 'p_new_subtasks': [{
        'parent_task_id': once_id,
        'task': {'title': 'Forbidden concurrent child', 'category_id': category,
                 'schedule': {'date': day(2), 'timezone': 'America/Phoenix'}}}]}
    series_change = {'p_task_id': once_id, 'p_expected_series_version': converted['task_version'],
                     'p_from_date': day(2), 'p_stop': False,
                     'p_rule': {'frequency': 'weekly', 'weekdays': [], 'end_date': None, 'fold_side': 'earlier'},
                     'p_schedule': {'date': day(2), 'timezone': 'America/Phoenix'},
                     'p_title': 'Weekly now', 'p_category_id': category}
    with ThreadPoolExecutor(max_workers=2) as pool:
        add_future = pool.submit(http, '/rest/v1/rpc/edit_task_tree', concurrent_add, token)
        series_future = pool.submit(http, '/rest/v1/rpc/change_recurring_series',
                                    series_change, token)
        add_status, add_body = add_future.result()
        series_status, revised = series_future.result()
    assert add_status >= 400 and add_body['code'] in ('0A000', '40001')
    assert 200 <= series_status < 300
    assert not any(row['title'] == 'Forbidden concurrent child' for row in
                   stored_rows('tasks', 'id,title'))
    assert revised['series_version'] > converted['task_version']
    week = ok('/rest/v1/rpc/list_recurrence_candidates',
              {'p_from': day(1), 'p_to': day(7)}, token)
    assert [row['recurrence_key'] for row in week if row['task_id'] == once_id] == [day(1), day(2)]
    kept = ok('/rest/v1/rpc/read_recurrence_context',
              {'p_task_id': once_id, 'p_key': day(3)}, token)
    assert kept['nodes'][0]['definition_snapshot']['title'] == 'Keep this exception'
    ok('/rest/v1/rpc/mutate_recurring_occurrence',
       {'p_task_id': once_id, 'p_recurrence_key': day(3),
        'p_expected_series_version': revised['series_version'],
        'p_expected_occurrence_version': changed_future['version'],
        'p_action': 'complete'}, token)
    child_series = ok('/rest/v1/rpc/create_recurring_task',
                      {'p_creation_key': str(uuid.uuid4()), 'p_task': task, 'p_rule': rule}, token)
    child_root = child_series['task_id']
    child_rows = ok('/rest/v1/rpc/list_recurrence_candidates',
                    {'p_from': day(2), 'p_to': day(2)}, token)
    child_id = next(row['task_id'] for row in child_rows if row['parent_task_id'] == child_root)
    child_context = ok('/rest/v1/rpc/read_recurrence_context',
                       {'p_task_id': child_id, 'p_key': day(2)}, token)
    child_revision = ok('/rest/v1/rpc/change_recurring_child_series',
                        {'p_task_id': child_id,
                         'p_expected_series_version': child_context['root_version'],
                         'p_from_date': day(2), 'p_title': 'Future child',
                         'p_location': None,
                         'p_schedule': {'date': day(4), 'timezone': 'America/Phoenix'}}, token)
    assert child_revision['series_version'] > child_context['root_version']
    revised_child_rows = ok('/rest/v1/rpc/list_recurrence_candidates',
                            {'p_from': day(4), 'p_to': day(4)}, token)
    assert any(row['task_id'] == child_id and row['recurrence_key'] == day(2) and
               row['definition_snapshot']['title'] == 'Future child' for row in revised_child_rows)

    # A parent move is one transaction: descendants keep their own wall times,
    # original dates and activity, and a stale competing request moves nothing.
    once_tree = ok('/rest/v1/rpc/create_task',
                   {'p_creation_key': str(uuid.uuid4()), 'p_task': task}, token)
    once_root = once_tree['task_id']
    def definition(node_id):
        return ok('/rest/v1/tasks?select=*&id=eq.' + node_id, token=token, method='GET')[0]
    def occurrence(node_id, occurrence_key='once'):
        return next(row for row in ok('/rest/v1/task_occurrences?select=*&task_id=eq.' + node_id,
                                      token=token, method='GET') if row['recurrence_key'] == occurrence_key)
    def activity(node_id):
        return ok('/rest/v1/task_activity?select=*&task_id=eq.' + node_id,
                  token=token, method='GET')
    once_child = next(row['id'] for row in ok('/rest/v1/tasks?select=id,parent_task_id',
                           token=token, method='GET') if row['parent_task_id'] == once_root)
    old_parent, old_child = occurrence(once_root), occurrence(once_child)
    once_move = ok('/rest/v1/rpc/postpone_task',
       {'p_task_id': once_root, 'p_expected_task_version': definition(once_root)['version'],
        'p_expected_occurrence_version': old_parent['version'],
        'p_schedule': {'date': day(3), 'timezone': 'America/Phoenix'}}, token)
    moved_parent, moved_child = occurrence(once_root), occurrence(once_child)
    assert moved_parent['scheduled_date'] == day(3) and moved_child['scheduled_date'] == day(4)
    assert moved_parent['id'] == old_parent['id'] and moved_child['id'] == old_child['id']
    assert moved_parent['original_date'] == day(0) and moved_child['original_date'] == day(1)
    assert once_move['root_version'] == definition(once_root)['version']
    assert once_move['occurrence_version'] == moved_parent['version']
    assert any(row['action'] == 'postponed' for row in activity(once_root))
    assert any(row['action'] == 'postponed' for row in activity(once_child))
    old_version = definition(once_root)['version']
    old_occurrence_version = moved_parent['version']
    def once_race(target):
        return http('/rest/v1/rpc/postpone_task',
            {'p_task_id': once_root, 'p_expected_task_version': old_version,
             'p_expected_occurrence_version': old_occurrence_version,
             'p_schedule': {'date': target, 'timezone': 'America/Phoenix'}}, token)
    with ThreadPoolExecutor(max_workers=2) as pool:
        once_results = list(pool.map(once_race, [day(5), day(6)]))
    assert sorted(code < 300 for code, _ in once_results) == [False, True]
    assert next(body['code'] for code, body in once_results if code >= 400) == '40001'
    assert occurrence(once_child)['scheduled_date'] == (
        datetime.fromisoformat(occurrence(once_root)['scheduled_date']) + timedelta(days=1)).date().isoformat()
    grandchild = ok('/rest/v1/rpc/create_task',
        {'p_creation_key': str(uuid.uuid4()),
         'p_task': {'title': 'Legacy nested child', 'category_id': category,
                    'schedule': {'date': day(2), 'timezone': 'America/Phoenix'}},
         'p_parent_task_id': once_child,
         'p_expected_parent_version': definition(once_child)['version'],
         'p_expected_parent_occurrence_version': occurrence(once_child)['version']}, token)['task_id']
    nested_before = occurrence(grandchild)
    root_before = occurrence(once_root)
    nested_delta = (datetime.fromisoformat(day(7)) - datetime.fromisoformat(root_before['scheduled_date'])).days
    ok('/rest/v1/rpc/postpone_task',
       {'p_task_id': once_root, 'p_expected_task_version': definition(once_root)['version'],
        'p_expected_occurrence_version': root_before['version'],
        'p_schedule': {'date': day(7), 'timezone': 'America/Phoenix'}}, token)
    assert occurrence(grandchild)['scheduled_date'] == (
        datetime.fromisoformat(nested_before['scheduled_date']) + timedelta(days=nested_delta)).date().isoformat()
    assert any(row['action'] == 'postponed' for row in activity(grandchild))

    gap_day = '2026-03-07'
    gap_tree = ok('/rest/v1/rpc/create_task', {'p_creation_key': str(uuid.uuid4()),
        'p_task': {'title': 'Gap parent', 'category_id': category,
                   'schedule': {'date': gap_day, 'timezone': 'America/New_York'},
                   'subtasks': [{'title': 'Gap child', 'category_id': category,
                                 'schedule': {'date': gap_day, 'timezone': 'America/New_York',
                                              'start_time': '02:30', 'starts_at': '2026-03-07T07:30:00Z'}}]}}, token)
    gap_root = gap_tree['task_id']
    gap_child = next(row['id'] for row in ok('/rest/v1/tasks?select=id,parent_task_id',
                           token=token, method='GET') if row['parent_task_id'] == gap_root)
    gap_before = (occurrence(gap_root), occurrence(gap_child), len(activity(gap_root)), len(activity(gap_child)))
    rejected, rejected_body = http('/rest/v1/rpc/postpone_task',
        {'p_task_id': gap_root, 'p_expected_task_version': definition(gap_root)['version'],
         'p_expected_occurrence_version': gap_before[0]['version'],
         'p_schedule': {'date': '2026-03-08', 'timezone': 'America/New_York'}}, token)
    assert rejected >= 400 and rejected_body['code'] == '22023'
    assert occurrence(gap_root) == gap_before[0] and occurrence(gap_child) == gap_before[1]
    assert len(activity(gap_root)) == gap_before[2] and len(activity(gap_child)) == gap_before[3]
    ok('/rest/v1/rpc/postpone_task',
       {'p_task_id': gap_root, 'p_expected_task_version': definition(gap_root)['version'],
        'p_expected_occurrence_version': gap_before[0]['version'],
        'p_schedule': {'date': '2026-03-09', 'timezone': 'America/New_York'}}, token)
    valid_child = occurrence(gap_child)
    assert valid_child['scheduled_date'] == '2026-03-09' and valid_child['start_time'] == '02:30:00'
    assert datetime.fromisoformat(valid_child['starts_at'].replace('Z', '+00:00')).astimezone(
        ZoneInfo('America/New_York')).strftime('%Y-%m-%d %H:%M') == '2026-03-09 02:30'
    assert valid_child['original_date'] == gap_day
    edit_gap_before = (occurrence(gap_root), occurrence(gap_child),
                       len(activity(gap_root)), len(activity(gap_child)))
    edit_gap, edit_gap_body = http('/rest/v1/rpc/edit_task_tree', {
        'p_root_task_id': gap_root, 'p_expected_root_version': definition(gap_root)['version'],
        'p_edits': [{'task_id': gap_root, 'task_version': definition(gap_root)['version'],
                     'occurrence_version': edit_gap_before[0]['version'],
                     'patch': {'schedule': {'date': '2026-03-08',
                                            'timezone': 'America/New_York'}}}]}, token)
    assert edit_gap >= 400 and edit_gap_body['code'] == '22023'
    assert (occurrence(gap_root), occurrence(gap_child), len(activity(gap_root)),
            len(activity(gap_child))) == edit_gap_before
    fold_tree = ok('/rest/v1/rpc/create_task', {'p_creation_key': str(uuid.uuid4()),
        'p_task': {'title': 'Fold parent', 'category_id': category,
                   'schedule': {'date': '2026-11-01', 'timezone': 'America/New_York'},
                   'subtasks': [{'title': 'Later fold child', 'category_id': category,
                                 'schedule': {'date': '2026-11-01', 'timezone': 'America/New_York',
                                              'start_time': '01:30', 'starts_at': '2026-11-01T06:30:00Z'}}]}}, token)
    fold_root = fold_tree['task_id']
    fold_child = next(row['id'] for row in ok('/rest/v1/tasks?select=id,parent_task_id',
                           token=token, method='GET') if row['parent_task_id'] == fold_root)
    ok('/rest/v1/rpc/postpone_task',
       {'p_task_id': fold_root, 'p_expected_task_version': definition(fold_root)['version'],
        'p_expected_occurrence_version': occurrence(fold_root)['version'],
        'p_schedule': {'date': '2027-11-07', 'timezone': 'America/New_York'}}, token)
    assert datetime.fromisoformat(occurrence(fold_child)['starts_at'].replace('Z', '+00:00')).isoformat() == '2027-11-07T06:30:00+00:00'

    recurring_tree = ok('/rest/v1/rpc/create_recurring_task',
        {'p_creation_key': str(uuid.uuid4()), 'p_task': task, 'p_rule': rule}, token)
    recurring_root = recurring_tree['task_id']
    recurring_child = next(row['task_id'] for row in ok('/rest/v1/rpc/list_recurrence_candidates',
        {'p_from': day(0), 'p_to': day(1)}, token) if row['parent_task_id'] == recurring_root)
    recurring_context = ok('/rest/v1/rpc/read_recurrence_context',
        {'p_task_id': recurring_root, 'p_key': day(0)}, token)
    ok('/rest/v1/rpc/mutate_recurring_occurrence',
       {'p_task_id': recurring_root, 'p_recurrence_key': day(0),
        'p_expected_series_version': recurring_context['root_version'],
        'p_expected_occurrence_version': 0, 'p_action': 'postpone',
        'p_schedule': {'date': day(2), 'timezone': 'America/Phoenix'}}, token)
    first_parent, first_child = occurrence(recurring_root, day(0)), occurrence(recurring_child, day(0))
    assert first_parent['scheduled_date'] == day(2) and first_child['scheduled_date'] == day(3)
    assert first_parent['original_date'] == day(0) and first_child['original_date'] == day(1)
    assert first_parent['is_exception'] and first_child['is_exception']
    assert len(activity(recurring_root)) == 1 and len(activity(recurring_child)) == 1
    assert not any(row['recurrence_key'] == day(1) for row in ok('/rest/v1/task_occurrences?select=recurrence_key&task_id=eq.' + recurring_root,
                                                              token=token, method='GET'))

    concurrent_context = ok('/rest/v1/rpc/read_recurrence_context',
        {'p_task_id': recurring_root, 'p_key': day(4)}, token)
    def race(target):
        return http('/rest/v1/rpc/mutate_recurring_occurrence',
            {'p_task_id': recurring_root, 'p_recurrence_key': day(4),
             'p_expected_series_version': concurrent_context['root_version'],
             'p_expected_occurrence_version': 0, 'p_action': 'postpone',
             'p_schedule': {'date': target, 'timezone': 'America/Phoenix'}}, token)
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(race, [day(5), day(6)]))
    assert sorted(code < 300 for code, _ in results) == [False, True]
    assert next(body['code'] for code, body in results if code >= 400) == '40001'
    race_parent, race_child = occurrence(recurring_root, day(4)), occurrence(recurring_child, day(4))
    assert race_child['scheduled_date'] == (datetime.fromisoformat(race_parent['scheduled_date']) + timedelta(days=1)).date().isoformat()
    assert len([row for row in activity(recurring_root) if row['occurrence_id'] == race_parent['id']]) == 1
    assert len([row for row in activity(recurring_child) if row['occurrence_id'] == race_child['id']]) == 1

    canceled_context = ok('/rest/v1/rpc/read_recurrence_context',
        {'p_task_id': recurring_root, 'p_key': day(1)}, token)
    ok('/rest/v1/rpc/mutate_recurring_occurrence',
       {'p_task_id': recurring_child, 'p_recurrence_key': day(1),
        'p_expected_series_version': canceled_context['root_version'],
        'p_expected_occurrence_version': 0, 'p_action': 'cancel'}, token)
    closed_child = occurrence(recurring_child, day(1))
    ok('/rest/v1/rpc/mutate_recurring_occurrence',
       {'p_task_id': recurring_root, 'p_recurrence_key': day(1),
        'p_expected_series_version': canceled_context['root_version'],
        'p_expected_occurrence_version': 0, 'p_action': 'postpone',
        'p_schedule': {'date': day(3), 'timezone': 'America/Phoenix'}}, token)
    assert occurrence(recurring_child, day(1)) == closed_child
    anon, _ = http('/rest/v1/rpc/postpone_task',
        {'p_task_id': once_root, 'p_expected_task_version': definition(once_root)['version'],
         'p_expected_occurrence_version': occurrence(once_root)['version'],
         'p_schedule': {'date': day(6), 'timezone': 'America/Phoenix'}})
    assert anon >= 400
    null_action, null_body = http('/rest/v1/rpc/mutate_recurring_occurrence',
        {'p_task_id': recurring_root, 'p_recurrence_key': day(6),
         'p_expected_series_version': definition(recurring_root)['version'],
         'p_expected_occurrence_version': 0, 'p_action': None}, token)
    assert null_action >= 400 and null_body['code'] == '22023'
    print('PASS: atomic parent/child postponement, recurring-key isolation, gap rollback, closed history and concurrent conflict')

    # A skipped parent must not leave an independently actionable child.
    next_year = datetime.now(ZoneInfo('America/New_York')).year + 1
    march_first = datetime(next_year, 3, 1)
    first_sunday = march_first + timedelta(days=(6 - march_first.weekday()) % 7)
    gap = first_sunday + timedelta(days=7)
    prior = gap - timedelta(days=1)
    prior_day, gap_day = prior.date().isoformat(), gap.date().isoformat()
    prior_instant = prior.replace(hour=2, minute=30, tzinfo=ZoneInfo('America/New_York'))
    gap_tree = ok('/rest/v1/rpc/create_recurring_task', {
        'p_creation_key': str(uuid.uuid4()),
        'p_task': {'title': 'DST parent', 'category_id': category,
                   'schedule': {'date': prior_day, 'timezone': 'America/New_York',
                                'start_time': '02:30', 'starts_at': prior_instant.astimezone(
                                    ZoneInfo('UTC')).isoformat()},
                   'subtasks': [{'title': 'DST child', 'category_id': category,
                                 'schedule': {'date': prior_day, 'timezone': 'America/New_York'}}]},
        'p_rule': rule}, token)
    gap_root = gap_tree['task_id']
    valid_rows = ok('/rest/v1/rpc/list_recurrence_candidates',
                    {'p_from': prior_day, 'p_to': prior_day}, token)
    gap_child = next(row['task_id'] for row in valid_rows if row['parent_task_id'] == gap_root)
    skipped = ok('/rest/v1/rpc/list_recurrence_candidates',
                 {'p_from': gap_day, 'p_to': gap_day}, token)
    assert not any(row['task_id'] in (gap_root, gap_child) for row in skipped)
    rejected, rejected_body = http('/rest/v1/rpc/mutate_recurring_occurrence', {
        'p_task_id': gap_child, 'p_recurrence_key': gap_day,
        'p_expected_series_version': definition(gap_root)['version'],
        'p_expected_occurrence_version': 0, 'p_action': 'complete'}, token)
    assert rejected >= 400 and rejected_body['code'] == 'P0002'
    assert not ok('/rest/v1/task_occurrences?select=id&task_id=eq.' + gap_child,
                  token=token, method='GET')
    # Simulate a preexisting, valid parent exception in the skipped slot. It
    # remains authoritative and makes its child available without changing history.
    sql = ("insert into public.task_occurrences(owner_id,task_id,recurrence_key,"
           "scheduled_date,timezone,start_time,starts_at,definition_snapshot) "
           "select owner_id,task_id,'" + gap_day + "','" + gap_day + "',timezone,"
           "'03:30',ventus_private.recurrence_instant('" + gap_day +
           "','03:30',timezone,'earlier'),definition_snapshot "
           "from public.task_recurrence_revisions where task_id='" + gap_root +
           "' and revision=1")
    subprocess.check_call([docker, 'exec', '-i', 'supabase_db_' + root.name,
        'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres',
        '-c', sql], stdout=subprocess.DEVNULL)
    preserved = ok('/rest/v1/rpc/list_recurrence_candidates',
                   {'p_from': gap_day, 'p_to': gap_day}, token)
    assert any(row['task_id'] == gap_child for row in preserved)
    ok('/rest/v1/rpc/mutate_recurring_occurrence', {
       'p_task_id': gap_child, 'p_recurrence_key': gap_day,
       'p_expected_series_version': definition(gap_root)['version'],
       'p_expected_occurrence_version': 0, 'p_action': 'complete'}, token)
    assert occurrence(gap_child, gap_day)['status'] == 'completed'
    following = (gap + timedelta(days=1)).date().isoformat()
    valid_after = ok('/rest/v1/rpc/list_recurrence_candidates',
                     {'p_from': following, 'p_to': following}, token)
    assert any(row['task_id'] == gap_root for row in valid_after)
    assert any(row['task_id'] == gap_child for row in valid_after)

    # Edit and Postpone have the same date-shift semantics, including rollback.
    edited_root = ok('/rest/v1/rpc/create_task', {'p_creation_key': str(uuid.uuid4()),
        'p_task': {'title': 'Editable parent', 'category_id': category,
                   'schedule': {'date': day(0), 'timezone': 'America/Phoenix'},
                   'subtasks': [{'title': label, 'category_id': category,
                                 'schedule': {'date': day(1), 'timezone': 'America/Phoenix'}}
                                for label in ('Open child', 'Completed child', 'Canceled child')]}}, token)['task_id']
    edit_children = ok('/rest/v1/tasks?select=id,title&parent_task_id=eq.' + edited_root,
                       token=token, method='GET')
    child_ids = {row['title']: row['id'] for row in edit_children}
    for label, rpc, extra in [('Completed child', 'set_task_completion', {'p_completed': True}),
                              ('Canceled child', 'cancel_task', {})]:
        child_id = child_ids[label]
        ok('/rest/v1/rpc/' + rpc, {'p_task_id': child_id,
            'p_expected_task_version': definition(child_id)['version'],
            'p_expected_occurrence_version': occurrence(child_id)['version'], **extra}, token)
    old_open = occurrence(child_ids['Open child'])
    old_closed = {label: occurrence(child_ids[label]) for label in ('Completed child', 'Canceled child')}
    before_edit = definition(edited_root)['version'], occurrence(edited_root)['version']
    ok('/rest/v1/rpc/edit_task_tree', {'p_root_task_id': edited_root,
       'p_expected_root_version': before_edit[0],
       'p_edits': [{'task_id': edited_root, 'task_version': before_edit[0],
                   'occurrence_version': before_edit[1],
                   'patch': {'title': 'Edited and moved parent',
                             'schedule': {'date': day(3), 'timezone': 'America/Phoenix'}}}]}, token)
    assert occurrence(edited_root)['scheduled_date'] == day(3)
    moved_open = occurrence(child_ids['Open child'])
    assert moved_open['scheduled_date'] == day(4) and moved_open['original_date'] == old_open['original_date']
    assert all(occurrence(child_ids[label]) == old_closed[label]
               for label in ('Completed child', 'Canceled child'))
    assert any(row['action'] == 'postponed' for row in activity(child_ids['Open child']))
    stale, stale_body = http('/rest/v1/rpc/edit_task_tree', {'p_root_task_id': edited_root,
       'p_expected_root_version': before_edit[0],
       'p_edits': [{'task_id': edited_root, 'task_version': before_edit[0],
                   'occurrence_version': before_edit[1],
                   'patch': {'schedule': {'date': day(5), 'timezone': 'America/Phoenix'}}}]}, token)
    assert stale >= 400 and stale_body['code'] == '40001'
    assert occurrence(child_ids['Open child']) == moved_open
    race_version = definition(edited_root)['version']
    race_occurrence = occurrence(edited_root)['version']
    def edit_race(target):
        return http('/rest/v1/rpc/edit_task_tree', {
            'p_root_task_id': edited_root, 'p_expected_root_version': race_version,
            'p_edits': [{'task_id': edited_root, 'task_version': race_version,
                         'occurrence_version': race_occurrence,
                         'patch': {'schedule': {'date': target,
                                                'timezone': 'America/Phoenix'}}}]}, token)
    with ThreadPoolExecutor(max_workers=2) as pool:
        edited_results = list(pool.map(edit_race, [day(5), day(6)]))
    assert sorted(code < 300 for code, _ in edited_results) == [False, True]
    assert next(body['code'] for code, body in edited_results if code >= 400) == '40001'
    assert occurrence(child_ids['Open child'])['scheduled_date'] == (
        datetime.fromisoformat(occurrence(edited_root)['scheduled_date']) + timedelta(days=1)).date().isoformat()
    old_parent_day = datetime.fromisoformat(occurrence(edited_root)['scheduled_date'])
    old_child_day = datetime.fromisoformat(occurrence(child_ids['Open child'])['scheduled_date'])
    ok('/rest/v1/rpc/edit_task_tree', {'p_root_task_id': edited_root,
       'p_expected_root_version': definition(edited_root)['version'],
       'p_edits': [{'task_id': edited_root, 'task_version': definition(edited_root)['version'],
                   'occurrence_version': occurrence(edited_root)['version'],
                   'patch': {'schedule': {'date': day(10), 'timezone': 'America/Phoenix'}}}],
       'p_new_subtasks': [{'parent_task_id': edited_root,
                           'task': {'title': 'New explicit child', 'category_id': category,
                                    'schedule': {'date': day(12), 'timezone': 'America/Phoenix'}}}]}, token)
    delta = (datetime.fromisoformat(day(10)) - old_parent_day).days
    assert occurrence(child_ids['Open child'])['scheduled_date'] == (old_child_day + timedelta(days=delta)).date().isoformat()
    added_id = next(row['id'] for row in ok('/rest/v1/tasks?select=id,title&parent_task_id=eq.' + edited_root,
                                           token=token, method='GET') if row['title'] == 'New explicit child')
    assert occurrence(added_id)['scheduled_date'] == day(12)

    recurring_edit_key = day(5)
    edit_context = ok('/rest/v1/rpc/read_recurrence_context',
                      {'p_task_id': recurring_root, 'p_key': recurring_edit_key}, token)
    edit_child_before = next(row for row in edit_context['nodes'] if row['task_id'] == recurring_child)
    ok('/rest/v1/rpc/mutate_recurring_occurrence', {
       'p_task_id': recurring_root, 'p_recurrence_key': recurring_edit_key,
       'p_expected_series_version': edit_context['root_version'],
       'p_expected_occurrence_version': 0, 'p_action': 'edit',
       'p_schedule': {'date': day(8), 'timezone': 'America/Phoenix'},
       'p_patch': {'title': 'Edited occurrence'}}, token)
    assert occurrence(recurring_root, recurring_edit_key)['scheduled_date'] == day(8)
    shifted_child = occurrence(recurring_child, recurring_edit_key)
    assert shifted_child['scheduled_date'] == day(9)
    assert shifted_child['original_date'] == edit_child_before['scheduled_date']
    assert not any(row['recurrence_key'] == day(6) for row in
                   ok('/rest/v1/task_occurrences?select=recurrence_key&task_id=eq.' + recurring_child,
                      token=token, method='GET'))

    # More than one page is returned without relying on the provider's set row cap.
    for index in range(105):
        ok('/rest/v1/rpc/create_recurring_task', {
            'p_creation_key': str(uuid.uuid4()),
            'p_task': {'title': 'Page ' + str(index), 'category_id': category,
                       'schedule': {'date': day(0), 'timezone': 'America/Phoenix'}},
            'p_rule': rule}, token)
    all_candidates = ok('/rest/v1/rpc/list_recurrence_candidates',
                        {'p_from': day(0), 'p_to': day(0)}, token)
    first_page = ok('/rest/v1/rpc/list_recurrence_candidates_page',
                    {'p_from': day(0), 'p_to': day(0)}, token)
    assert len(first_page) == 100
    last = first_page[-1]
    second_page = ok('/rest/v1/rpc/list_recurrence_candidates_page', {
        'p_from': day(0), 'p_to': day(0), 'p_after_task_id': last['task_id'],
        'p_after_key': last['recurrence_key']}, token)
    ids = [(row['task_id'], row['recurrence_key']) for row in first_page + second_page]
    assert len(ids) == len(set(ids)) == len(all_candidates)
    assert set(ids) == {(row['task_id'], row['recurrence_key']) for row in all_candidates}
    anonymous_page, _ = http('/rest/v1/rpc/list_recurrence_candidates_page',
                             {'p_from': day(0), 'p_to': day(0)})
    assert anonymous_page >= 400
    print('PASS: DST parent/child isolation, atomic parent date edits, history, capped pages and anonymous denial')

    # Exercise the actual application reads against local PostgreSQL/PostgREST.
    # The Node transport caps table replies at two rows; the data stays real.
    live_email = 'recurrence-reads-' + uuid.uuid4().hex + '@example.test'
    live_user = ok('/auth/v1/admin/users', {'email': live_email, 'password': password,
                                           'email_confirm': True}, admin=True)
    try:
        live_token = ok('/auth/v1/token?grant_type=password',
                        {'email': live_email, 'password': password})['access_token']
        ok('/rest/v1/rpc/initialize_workspace', {'p_timezone': 'America/Phoenix'}, live_token)
        deadline_category = ok('/rest/v1/categories?select=id&behavior=eq.deadline&limit=1',
                               token=live_token, method='GET')[0]['id']
        series_ids, stored_ids = [], []
        for index in range(7):
            series_id = ok('/rest/v1/rpc/create_recurring_task', {
                'p_creation_key': str(uuid.uuid4()),
                'p_task': {'title': 'Read page ' + str(index), 'category_id': deadline_category,
                           'schedule': {'date': day(0), 'timezone': 'America/Phoenix'}},
                'p_rule': {'frequency': 'daily', 'weekdays': [], 'end_date': day(0),
                           'fold_side': 'earlier'}}, live_token)['task_id']
            series_ids.append(series_id)
            if index < 5:
                context = ok('/rest/v1/rpc/read_recurrence_context',
                             {'p_task_id': series_id, 'p_key': day(0)}, live_token)
                ok('/rest/v1/rpc/mutate_recurring_occurrence', {
                    'p_task_id': series_id, 'p_recurrence_key': day(0),
                    'p_expected_series_version': context['root_version'],
                    'p_expected_occurrence_version': 0, 'p_action': 'edit',
                    'p_patch': {'title': 'Stored exception ' + str(index)}}, live_token)
                stored_ids.append(series_id)
        today = datetime.now(ZoneInfo('America/Phoenix')).date()
        past_ids = []
        for age in (120, 240):
            past_ids.append(ok('/rest/v1/rpc/create_task', {
                'p_creation_key': str(uuid.uuid4()),
                'p_task': {'title': 'Old unfinished ' + str(age), 'category_id': deadline_category,
                           'schedule': {'date': (today-timedelta(days=age)).isoformat(),
                                        'timezone': 'America/Phoenix'}}}, live_token)['task_id'])
        read_tables = ('task_occurrences', 'task_activity', 'task_recurrence_revisions')
        before_reads = {table: sorted(ok('/rest/v1/' + table + '?select=id,version,scheduled_date,status',
                                          token=live_token, method='GET'), key=lambda row: row['id'])
                        if table == 'task_occurrences' else
                        sorted(ok('/rest/v1/' + table + '?select=id', token=live_token,
                                  method='GET'), key=lambda row: row['id']) for table in read_tables}
        payload = {'base': base, 'key': key, 'token': live_token, 'userId': live_user['id'],
                   'keyDate': day(0), 'seriesIds': series_ids, 'storedIds': stored_ids,
                   'pastIds': past_ids}
        read_test = subprocess.run(['node', str(Path(__file__).with_name('verify_live_reads.mjs'))],
                                   input=json.dumps(payload), text=True, capture_output=True, timeout=120)
        if read_test.returncode:
            detail = read_test.stderr.replace(live_token, '[redacted]').replace(key, '[redacted]')
            raise AssertionError('Local live read regression failed: ' + detail[-1500:])
        print(read_test.stdout.strip())
        after_reads = {table: sorted(ok('/rest/v1/' + table + '?select=id,version,scheduled_date,status',
                                         token=live_token, method='GET'), key=lambda row: row['id'])
                       if table == 'task_occurrences' else
                       sorted(ok('/rest/v1/' + table + '?select=id', token=live_token,
                                 method='GET'), key=lambda row: row['id']) for table in read_tables}
        assert before_reads == after_reads, 'Read projections wrote task history'
    finally:
        ok('/auth/v1/admin/users/' + live_user['id'], admin=True, method='DELETE')

    other_email = 'recurrence-' + uuid.uuid4().hex + '@example.test'
    other = ok('/auth/v1/admin/users', {'email': other_email, 'password': password,
                                        'email_confirm': True}, admin=True)
    try:
        other_token = ok('/auth/v1/token?grant_type=password',
                         {'email': other_email, 'password': password})['access_token']
        ok('/rest/v1/rpc/initialize_workspace', {'p_timezone': 'America/Phoenix'}, other_token)
        assert ok('/rest/v1/task_recurrence_revisions?select=id',
                  token=other_token, method='GET') == []
        assert all(row['task_id'] != once_id and row['task_id'] != task_id for row in
                   ok('/rest/v1/rpc/list_recurrence_candidates',
                      {'p_from': day(0), 'p_to': day(6)}, other_token))
        foreign, _ = http('/rest/v1/rpc/mutate_recurring_occurrence',
                          {'p_task_id': once_id, 'p_recurrence_key': day(2),
                           'p_expected_series_version': revised['series_version'],
                           'p_expected_occurrence_version': 0, 'p_action': 'complete'}, other_token)
        assert foreign >= 400
        foreign_parent_before = occurrence(recurring_root, day(0))
        foreign_child_before = occurrence(recurring_child, day(0))
        foreign_postpone, _ = http('/rest/v1/rpc/mutate_recurring_occurrence',
            {'p_task_id': recurring_root, 'p_recurrence_key': day(0),
             'p_expected_series_version': definition(recurring_root)['version'],
             'p_expected_occurrence_version': foreign_parent_before['version'],
             'p_action': 'postpone',
             'p_schedule': {'date': day(6), 'timezone': 'America/Phoenix'}}, other_token)
        assert foreign_postpone >= 400
        assert occurrence(recurring_root, day(0)) == foreign_parent_before
        assert occurrence(recurring_child, day(0)) == foreign_child_before
    finally:
        ok('/auth/v1/admin/users/' + other['id'], admin=True, method='DELETE')
    print('PASS: authenticated recurrence creation, conversion, series edit/stop, exception actions, history, duplicate and cross-account protections')
finally:
    ok('/auth/v1/admin/users/' + user['id'], admin=True, method='DELETE')
