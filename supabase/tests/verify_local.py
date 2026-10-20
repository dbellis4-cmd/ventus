"""Disposable localhost-only Supabase integration verification. No hosted fallback.

Usage: python3 -B supabase/tests/verify_local.py /private/tmp/ventus-m3-local-...
The directory must contain local-status.json captured privately from CLI status.
Credentials stay in memory/private temporary files and are never printed.
"""
import concurrent.futures
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

ROOT = Path(sys.argv[1]).resolve()
assert ROOT.parent == Path('/private/tmp') and ROOT.name.startswith('ventus-m3-local-')
assert not (ROOT / 'supabase/.temp/project-ref').exists(), 'Linked project forbidden'
assert not list(ROOT.glob('.env*')), 'Environment files forbidden in test workspace'
CONFIG = json.loads((ROOT / 'local-status.json').read_text())
BASE = CONFIG['API_URL'].rstrip('/')
assert BASE == 'http://127.0.0.1:58431', 'Only the dedicated loopback endpoint is allowed'
assert urllib.parse.urlsplit(CONFIG['DB_URL']).hostname in ('localhost', '127.0.0.1')
DOCKER = '/Applications/Docker.app/Contents/Resources/bin/docker'
CONTAINER = 'supabase_db_' + ROOT.name
ENV = {k: os.environ[k] for k in ('HOME', 'USER', 'TMPDIR', 'PATH') if k in os.environ}
ENV['DOCKER_HOST'] = 'unix:///Users/dantebellissimo/.docker/run/docker.sock'
ENV.pop('DOCKER_CONTEXT', None)
TABLES = ('user_settings', 'categories', 'tasks', 'task_occurrences', 'task_activity')
COUNT = 0
ERRORS = []
USERS = []


def check(name, condition):
    global COUNT
    assert condition, name
    COUNT += 1
    print('PASS:', name, flush=True)


def http(path, token=None, body=None, method='GET', admin=False, headers=None):
    assert path.startswith('/') and not path.startswith('//') and '://' not in path
    hdr = {'apikey': CONFIG.get('PUBLISHABLE_KEY') or CONFIG['ANON_KEY']}
    if token:
        hdr['Authorization'] = 'Bearer ' + token
    if admin:
        hdr['Authorization'] = 'Bearer ' + CONFIG['SERVICE_ROLE_KEY']
    if body is not None:
        hdr['Content-Type'] = 'application/json'
    if headers:
        hdr.update(headers)
    request = urllib.request.Request(BASE + path, data=None if body is None else json.dumps(body).encode(), headers=hdr, method=method)
    # No proxy use or redirects to another address, including error redirects.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, response_headers, newurl):
            raise AssertionError('Redirect forbidden in local verification')
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    try:
        response = opener.open(request, timeout=20)
    except urllib.error.HTTPError as error:
        response = error
    raw = response.read().decode()
    try:
        result = json.loads(raw) if raw else None
    except json.JSONDecodeError:
        result = {'code': 'non-json-response'}
    return response.status, result


def success(result):
    status, body = result
    if not 200 <= status < 300:
        code = body.get('code', 'unknown') if isinstance(body, dict) else 'unknown'
        # Deliberately omit all payloads, credentials and response text.
        safe_detail = ''
        if code == '42501' and isinstance(body, dict) and body.get('message', '').startswith('permission denied for '):
            safe_detail = '; ' + body['message']
        raise AssertionError(f'Unexpected local API failure: HTTP {status}, code {code}{safe_detail}')
    return body


def rpc(user, name, payload):
    return http('/rest/v1/rpc/' + name, user['token'] if user else None, payload, 'POST')


def call(user, name, payload):
    try:
        return success(rpc(user, name, payload))
    except AssertionError as error:
        raise AssertionError(name + ': ' + str(error)) from None


def denied(name, result, codes=None):
    status, body = result
    check(name, status >= 400 and (codes is None or isinstance(body, dict) and body.get('code') in codes))


def rows(user, table, query=''):
    return success(http('/rest/v1/' + table + '?select=*' + query, user['token']))


def snapshot(user):
    return {table: sorted(rows(user, table), key=lambda r: r.get('id', r.get('user_id'))) for table in TABLES}


def sql(source, expected_error=None):
    proc = subprocess.run([DOCKER, 'exec', '-i', CONTAINER, 'psql', '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=sqlstate', '-U', 'postgres', '-d', 'postgres'], input=source, text=True, capture_output=True, env=ENV, timeout=25)
    if expected_error:
        assert proc.returncode and expected_error in proc.stderr, 'Expected controlled SQL rejection: ' + expected_error
        return None
    if proc.returncode:
        match = re.search(r'ERROR:\s+(\w{5})', proc.stderr)
        raise AssertionError('Local observer/harness SQL failed: ' + (match.group(1) if match else 'unknown'))
    return proc.stdout.strip()


def as_writer(user, command, error):
    claims = json.dumps({'sub': user['id'], 'role': 'authenticated'})
    source = "begin; set local role ventus_writer; select set_config('request.jwt.claims', '" + claims + "', true); " + command + '; set constraints all immediate; rollback;'
    sql(source, error)


def new_user():
    password = uuid.uuid4().hex + '!Aa9'
    email = 'ventus-local-' + uuid.uuid4().hex + '@example.test'
    account = success(http('/auth/v1/admin/users', body={'email': email, 'password': password, 'email_confirm': True}, method='POST', admin=True))
    signed = success(http('/auth/v1/token?grant_type=password', body={'email': email, 'password': password}, method='POST'))
    user = {'id': account['id'], 'token': signed['access_token']}
    USERS.append(user)
    call(user, 'initialize_workspace', {'p_timezone': 'America/Phoenix'})
    user['category'] = rows(user, 'categories')[0]['id']
    return user


def doc(user, title='Local verification', schedule=None, **extra):
    return {'title': title, 'category_id': user['category'], 'schedule': schedule or {'date': '2026-10-19', 'timezone': 'America/Phoenix'}, **extra}


def create(user, document=None, key=None, **extra):
    return call(user, 'create_task', {'p_creation_key': key or str(uuid.uuid4()), 'p_task': document or doc(user), **extra})


def current(user, task_id):
    task = rows(user, 'tasks', '&id=eq.' + task_id)[0]
    occurrence = rows(user, 'task_occurrences', '&task_id=eq.' + task_id)[0]
    return task, occurrence


def versions(user, task_id):
    task, occurrence = current(user, task_id)
    return {'p_task_id': task_id, 'p_expected_task_version': task['version'], 'p_expected_occurrence_version': occurrence['version']}


def edit(user, task_id, patch):
    task, occurrence = current(user, task_id)
    return call(user, 'edit_task_tree', {'p_root_task_id': task_id, 'p_expected_root_version': task['version'], 'p_edits': [{'task_id': task_id, 'task_version': task['version'], 'occurrence_version': occurrence['version'], 'patch': patch}]})


def install_fault(action=None):
    predicate = 'true' if action is None else "new.action='" + action + "'"
    sql("create function ventus_private.local_test_fail_history() returns trigger language plpgsql security invoker set search_path='' as $$ begin if " + predicate + " then raise exception using errcode='P0001',message='Deliberate local rollback test'; end if; return new; end; $$; revoke all on function ventus_private.local_test_fail_history() from public,anon,authenticated,service_role; create trigger local_test_fail_history before insert on public.task_activity for each row execute function ventus_private.local_test_fail_history();")


def remove_fault():
    sql('drop trigger if exists local_test_fail_history on public.task_activity; drop function if exists ventus_private.local_test_fail_history();')


def run():
    metadata = json.loads(sql("select jsonb_agg(jsonb_build_object('name',relname,'rls',relrowsecurity,'force',relforcerowsecurity)) from pg_class where relnamespace='public'::regnamespace and relkind='r';"))
    check('five tables with enabled and forced RLS', {x['name'] for x in metadata} == set(TABLES) and all(x['rls'] and x['force'] for x in metadata))
    check('restricted nonlogin writer has no RLS bypass', sql("select (not rolcanlogin and not rolinherit and not rolbypassrls)::text from pg_roles where rolname='ventus_writer';") == 'true')
    check('writer is not a table owner', sql("select count(*) from pg_tables where schemaname='public' and tableowner='ventus_writer';") == '0')
    check('no API roles are writer members', sql("select count(*) from pg_auth_members m join pg_roles r on r.oid=m.roleid join pg_roles u on u.oid=m.member where r.rolname='ventus_writer' and u.rolname<>'postgres';") == '0')
    check('ten restricted public RPC owners', sql("select count(*) from pg_proc p join pg_roles r on r.oid=p.proowner where p.pronamespace='public'::regnamespace and p.prosecdef and r.rolname='ventus_writer' and p.proconfig @> array['search_path=\"\"','row_security=on'] and not has_function_privilege('anon',p.oid,'EXECUTE') and not has_function_privilege('service_role',p.oid,'EXECUTE');") == '10')
    check('both migrations recorded in expected order', sql("select string_agg(version,',' order by version) from supabase_migrations.schema_migrations;") == '20261019000100,20261019000200')
    check('UID bridge uses invoker security and pre-parsed SQL body', sql("select (not prosecdef and prosqlbody is not null)::text from pg_proc where oid='ventus_private.request_user_id()'::regprocedure;") == 'true')
    sql('begin; create table ventus_private.local_test_migration_rollback(id integer); select 1/0; commit;', '22012')
    check('failed transactional DDL leaves no partial schema', sql("select (to_regclass('ventus_private.local_test_migration_rollback') is null)::text;") == 'true')
    a, b = new_user(), new_user()
    check('two local Auth users log in and initialize privately', a['id'] != b['id'] and len(rows(a, 'categories')) == len(rows(b, 'categories')) == 7)
    names = {'Classes','Meetings','Assignments','Professional Events','Social Events','Personal Tasks','Miscellaneous'}
    check('approved category defaults', {c['name'] for c in rows(a, 'categories')} == names)
    with concurrent.futures.ThreadPoolExecutor(4) as pool:
        list(pool.map(lambda _: call(a, 'initialize_workspace', {'p_timezone': 'UTC'}), range(4)))
    check('concurrent initialization preserves categories and timezone', len(rows(a, 'categories')) == 7 and rows(a, 'user_settings')[0]['timezone'] == 'America/Phoenix')
    for table in TABLES:
        denied('anonymous read denied: ' + table, http('/rest/v1/' + table + '?select=*'), {'42501'})
        owner_col = 'user_id' if table == 'user_settings' else 'owner_id'
        check('A cannot select B: ' + table, rows(a, table, '&' + owner_col + '=eq.' + b['id']) == [])
        check('B cannot select A: ' + table, rows(b, table, '&' + owner_col + '=eq.' + a['id']) == [])
    denied('anonymous RPC denied', rpc(None, 'initialize_workspace', {'p_timezone': 'UTC'}), {'42501'})
    denied('forged JWT denied', http('/rest/v1/tasks?select=*', 'invalid-local-fixture-token'))
    root = create(a, doc(a, subtasks=[doc(a, 'Child one'), doc(a, 'Child two', subtasks=[doc(a, 'Grandchild')])]))
    other = create(b)
    root_id = root['task_id']; b_id = other['task_id']
    check('atomic root and nested dated subtasks created', len(rows(a, 'tasks')) == len(rows(a, 'task_occurrences')) == len(rows(a, 'task_activity')) == 4)
    for table in TABLES:
        own_row = rows(a, table)[0]
        pk = 'user_id' if table == 'user_settings' else 'id'
        for method, payload in [('POST', own_row), ('PATCH', {'version': 999} if table != 'task_activity' else {'action': 'edited'}), ('DELETE', None)]:
            denied('direct own ' + method + ' denied: ' + table, http('/rest/v1/' + table + '?' + pk + '=eq.' + own_row[pk], a['token'], payload, method), {'42501'})
    check('embedded category joins preserve isolation', success(http('/rest/v1/tasks?select=id,categories(name)&owner_id=eq.' + b['id'], a['token'])) == [])
    bv = versions(b, b_id); before_b = snapshot(b)
    for name, payload in [
        ('set_task_completion', {**bv, 'p_completed': True}), ('postpone_task', {**bv, 'p_schedule': doc(a)['schedule']}),
        ('cancel_task', bv), ('soft_delete_task', {**bv, 'p_expected_root_version': other['root_version']}),
        ('edit_task_tree', {'p_root_task_id': b_id, 'p_expected_root_version': other['root_version'], 'p_edits': []}),
        ('create_task', {'p_creation_key': str(uuid.uuid4()), 'p_task': doc(a), 'p_parent_task_id': b_id, 'p_expected_parent_version': 1, 'p_expected_parent_occurrence_version': 1}),
    ]:
        denied('cross-user RPC denied: ' + name, rpc(a, name, payload))
    denied('cross-user category assignment denied', rpc(a, 'create_task', {'p_creation_key': str(uuid.uuid4()), 'p_task': doc(a, category_id=b['category'])}))
    denied('reverse cross-user task mutation denied', rpc(b, 'cancel_task', versions(a, root_id)))
    check('B unchanged after all foreign write attempts', snapshot(b) == before_b)
    for field in ('owner_id','status','version','original_date','definition_snapshot','creation_key','rrule','recurrence'):
        denied('protected/recurrence field rejected: ' + field, rpc(a, 'create_task', {'p_creation_key': str(uuid.uuid4()), 'p_task': doc(a, **{field: None})}), {'22023','0A000'})
    for command, code in [
        ("update public.tasks set owner_id='" + b['id'] + "' where id='" + root_id + "'", '42501'),
        ("update public.tasks set category_id='" + b['category'] + "' where id='" + root_id + "'", '23503'),
        ("update public.task_occurrences set original_date=original_date+1 where task_id='" + root_id + "'", '42501'),
        ("update public.user_settings set defaults_initialized_at=null where user_id='" + a['id'] + "'", '42501'),
        ("insert into public.task_occurrences(owner_id,task_id,scheduled_date,timezone,definition_snapshot) select owner_id,task_id,scheduled_date,timezone,definition_snapshot from public.task_occurrences where task_id='" + root_id + "'", '23505'),
    ]:
        as_writer(a, command, code)
        check('controlled writer integrity rejection ' + code, True)
    sql("delete from public.task_activity where owner_id='" + a['id'] + "';", '42501')
    check('history hard deletion blocked while Auth owner exists', True)
    original = current(a, root_id)[1]
    edit(a, root_id, {'title': 'Edited root'})
    call(a, 'postpone_task', {**versions(a, root_id), 'p_schedule': {'date': '2026-10-22', 'timezone': 'America/Phoenix'}})
    check('postponement preserves original deadline and identity', current(a, root_id)[1]['original_date'] == original['original_date'] and current(a, root_id)[1]['id'] == original['id'])
    call(a, 'set_task_completion', {**versions(a, root_id), 'p_completed': True, 'p_actual_completed_at': '2026-01-01T12:00:00Z'})
    call(a, 'set_task_completion', {**versions(a, root_id), 'p_completed': True, 'p_actual_completed_at': '2026-01-01T13:00:00Z'})
    before_noop = snapshot(a)
    call(a, 'set_task_completion', {**versions(a, root_id), 'p_completed': True})
    check('same desired completion is a no-op', before_noop == snapshot(a))
    call(a, 'set_task_completion', {**versions(a, root_id), 'p_completed': False})
    actions = [e['action'] for e in rows(a, 'task_activity', '&task_id=eq.' + root_id)]
    check('completion, correction and reopening history retained', all(s in actions for s in ('created','edited','postponed','completed','completion_corrected','reopened')))
    denied('future actual completion rejected', rpc(a, 'set_task_completion', {**versions(a, root_id), 'p_completed': True, 'p_actual_completed_at': '2999-01-01T00:00:00Z'}), {'22023'})
    child_id = next(t['id'] for t in rows(a, 'tasks') if t['parent_task_id'] == root_id)
    call(a, 'set_task_completion', {**versions(a, child_id), 'p_completed': True})
    check('child completion does not complete parent', current(a, root_id)[1]['status'] == 'open')
    canceled = create(a)['task_id']; call(a, 'cancel_task', versions(a, canceled))
    check('cancellation retains deadline without completion', current(a, canceled)[1]['status'] == 'canceled' and current(a, canceled)[1]['completed_at'] is None)
    denied('canceled completion rejected', rpc(a, 'set_task_completion', {**versions(a, canceled), 'p_completed': True}), {'22023'})
    # Category snapshots survive rename/archive and preference changes.
    category = next(c for c in rows(a, 'categories') if c['id'] == a['category'])
    before_snapshot = current(a, root_id)[1]['definition_snapshot']
    call(a, 'update_category', {'p_category_id': category['id'], 'p_expected_version': category['version'], 'p_name': 'Archived local category', 'p_behavior': category['behavior'], 'p_calendar_default': category['calendar_default'], 'p_archived': True})
    check('category changes preserve occurrence snapshot', current(a, root_id)[1]['definition_snapshot'] == before_snapshot)
    denied('archived category rejects new assignments', rpc(a, 'create_task', {'p_creation_key': str(uuid.uuid4()), 'p_task': doc(a)}))
    category_id = call(a, 'create_category', {'p_name': 'Local custom', 'p_behavior': 'flexible', 'p_calendar_default': False})
    a['category'] = category_id
    check('custom category creation supported', any(c['id'] == category_id for c in rows(a, 'categories')))
    before = snapshot(a)
    failed_key = str(uuid.uuid4())
    denied('late invalid subtask rolls back entire creation', rpc(a, 'create_task', {'p_creation_key': failed_key, 'p_task': doc(a, subtasks=[doc(a), doc(a, category_id=b['category'])])}))
    check('failed creation leaves no partial state/history', before == snapshot(a))
    # All lifecycle mutations fail closed when history cannot be recorded.
    for name in ('create_task','edit_task_tree','set_task_completion','postpone_task','cancel_task','soft_delete_task'):
        target = create(a)['task_id']; tv = versions(a, target); t, o = current(a, target)
        payloads = {
            'create_task': {'p_creation_key': str(uuid.uuid4()), 'p_task': doc(a, subtasks=[doc(a)])},
            'edit_task_tree': {'p_root_task_id': target, 'p_expected_root_version': t['version'], 'p_edits': [{'task_id': target,'task_version':t['version'],'occurrence_version':o['version'],'patch':{'title':'Must roll back'}}]},
            'set_task_completion': {**tv,'p_completed':True}, 'postpone_task': {**tv,'p_schedule':{'date':'2026-10-23','timezone':'UTC'}},
            'cancel_task':tv, 'soft_delete_task':{**tv,'p_expected_root_version':t['version']},
        }
        before = snapshot(a)
        install_fault()
        try:
            denied('history failure rejects ' + name, rpc(a, name, payloads[name]), {'P0001'})
        finally:
            remove_fault()
        check('atomic state/history rollback: ' + name, snapshot(a) == before)
    # Mixed edit: update root, create child, explicitly remove another in one call.
    mixed = create(a, doc(a, subtasks=[doc(a)]))['task_id']
    mt, mo = current(a, mixed); old_child = next(t for t in rows(a, 'tasks') if t['parent_task_id'] == mixed)
    ct, co = current(a, old_child['id'])
    payload = {'p_root_task_id':mixed,'p_expected_root_version':mt['version'],'p_edits':[{'task_id':mixed,'task_version':mt['version'],'occurrence_version':mo['version'],'patch':{'title':'Atomic mixed edit'}}], 'p_new_subtasks':[{'parent_task_id':mixed,'task':doc(a)}], 'p_delete_subtasks':[{'task_id':ct['id'],'task_version':ct['version'],'occurrence_version':co['version']}]}
    before = snapshot(a); install_fault('deleted')
    try:
        denied('late mixed-edit deletion failure', rpc(a, 'edit_task_tree', payload), {'P0001'})
    finally:
        remove_fault()
    check('mixed root/create/delete changes all rolled back', before == snapshot(a))
    call(a, 'edit_task_tree', payload)
    check('mixed root/create/delete commits together', current(a, mixed)[0]['title'] == 'Atomic mixed edit' and current(a, ct['id'])[0]['deleted_at'] is not None)
    # Explicit DST, offsets, anytime and overnight cases.
    valid_slots = [
        {'date':'2026-11-01','timezone':'America/New_York','start_time':'01:30','starts_at':'2026-11-01T05:30:00Z'},
        {'date':'2026-11-01','timezone':'America/New_York','start_time':'01:30','starts_at':'2026-11-01T06:30:00Z'},
        {'date':'2026-10-19','timezone':'Asia/Kathmandu','start_time':'09:00','starts_at':'2026-10-19T03:15:00Z'},
        {'date':'2028-02-29','timezone':'UTC','start_time':'23:00','starts_at':'2028-02-29T23:00:00Z','end_date':'2028-03-01','end_time':'01:00','ends_at':'2028-03-01T01:00:00Z'},
    ]
    for index, slot in enumerate(valid_slots):
        created = create(a, doc(a, schedule=slot))
        check('explicit zone/fold/overnight valid case ' + str(index+1), current(a, created['task_id'])[1]['starts_at'] is not None)
    invalid_slots = [
        {'date':'2026-03-08','timezone':'America/New_York','start_time':'02:30','starts_at':'2026-03-08T07:30:00Z'},
        {'date':'2026-11-01','timezone':'America/New_York','start_time':'01:30','starts_at':'2026-11-01T04:30:00Z'},
        {'date':'2026-11-01','timezone':'America/New_York','start_time':'01:30','starts_at':'2026-11-01T01:30:00'},
        {'date':'2026-10-19','timezone':'EST'}, {'date':'2026-10-19','timezone':'posix/America/New_York'},
        {'date':'2026-02-30','timezone':'UTC'}, {'date':'2026-10-19','timezone':'UTC','starts_at':'2026-10-19T00:00:00Z'},
        {'date':'2026-10-19','timezone':'UTC','start_time':'24:00','starts_at':'2026-10-20T00:00:00Z'},
        {'date':'2026-10-19','timezone':'UTC','start_time':'12:00','starts_at':'2026-10-19T12:00:00Z','end_time':'13:00'},
    ]
    for index, slot in enumerate(invalid_slots):
        denied('invalid zone/DST/date/pair rejected ' + str(index+1), rpc(a,'create_task',{'p_creation_key':str(uuid.uuid4()),'p_task':doc(a,schedule=slot)}))
    occurrences_before = rows(a, 'task_occurrences')
    settings = rows(a, 'user_settings')[0]
    call(a,'update_settings',{'p_expected_version':settings['version'],'p_timezone':'UTC','p_appearance':'dark'})
    check('account timezone change never moves existing slots', rows(a, 'task_occurrences') == occurrences_before)
    # Concurrent creation keys and stale updates use separate HTTP transactions.
    for parent in (None, create(a)['task_id']):
        key = str(uuid.uuid4()); document = doc(a, subtasks=[doc(a)])
        extra = {}
        if parent:
            pt, po = current(a, parent); extra={'p_parent_task_id':parent,'p_expected_parent_version':pt['version'],'p_expected_parent_occurrence_version':po['version']}
        args={'p_creation_key':key,'p_task':document,**extra}
        with concurrent.futures.ThreadPoolExecutor(6) as pool:
            results=list(pool.map(lambda _:success(rpc(a,'create_task',args)),range(6)))
        check('concurrent creation key deduplicates ' + ('child' if parent else 'root'), len({r['task_id'] for r in results}) == 1 and sum(r['created'] for r in results)==1)
        denied('same key different input rejected', rpc(a,'create_task',{**args,'p_task':doc(a,'Different input')}), {'22023'})
    race = create(a)['task_id']; same = {**versions(a,race),'p_completed':True}
    with concurrent.futures.ThreadPoolExecutor(2) as pool:
        result=list(pool.map(lambda _:rpc(a,'set_task_completion',same),range(2)))
    check('same-record concurrent updates: one commit, one stale conflict', sum(200<=r[0]<300 for r in result)==1 and sum(r[1].get('code')=='40001' for r in result)==1)
    check('duplicate update produces one completion event', len([e for e in rows(a,'task_activity','&task_id=eq.'+race) if e['action']=='completed'])==1)
    edit_race=create(a)['task_id']; et,eo=current(a,edit_race)
    base_edit={'p_root_task_id':edit_race,'p_expected_root_version':et['version']}
    def concurrent_edit(title):
        return rpc(a,'edit_task_tree',{**base_edit,'p_edits':[{'task_id':edit_race,'task_version':et['version'],'occurrence_version':eo['version'],'patch':{'title':title}}]})
    with concurrent.futures.ThreadPoolExecutor(2) as pool:
        edited=list(pool.map(concurrent_edit,('Concurrent edit one','Concurrent edit two')))
    check('actual concurrent definition edits reject stale overwrite',sum(200<=r[0]<300 for r in edited)==1 and sum(r[1].get('code')=='40001' for r in edited)==1)
    check('concurrent definition edit records exactly one edit event',len([e for e in rows(a,'task_activity','&task_id=eq.'+edit_race) if e['action']=='edited'])==1)
    deletion = create(a, doc(a, subtasks=[doc(a)]))['task_id']; dv=versions(a,deletion)
    deletion_root=current(a,deletion)[0]['version']
    with concurrent.futures.ThreadPoolExecutor(2) as pool:
        jobs=[pool.submit(rpc,a,'soft_delete_task',{**dv,'p_expected_root_version':deletion_root}),pool.submit(rpc,a,'create_task',{'p_creation_key':str(uuid.uuid4()),'p_task':doc(a),'p_parent_task_id':deletion,'p_expected_parent_version':dv['p_expected_task_version'],'p_expected_parent_occurrence_version':dv['p_expected_occurrence_version']})]
        outcomes=[j.result() for j in jobs]
    dt=current(a,deletion)[0]
    children=[t for t in rows(a,'tasks') if t['parent_task_id']==deletion]
    check('child insertion/deletion race has no live orphan', dt['deleted_at'] is None or all(t['deleted_at'] for t in children))
    check('child insertion/deletion conflict is surfaced', any(r[0]>=400 for r in outcomes))
    # Independent roots remain writable while an existing root is held locked.
    unlocked = create(a)['task_id']; held=create(a)['task_id']
    def hold():
        sql("set application_name='ventus_m3_lock_probe'; begin; select id from public.tasks where id='"+held+"' for update; select pg_sleep(4); rollback;")
    with concurrent.futures.ThreadPoolExecutor(1) as pool:
        job=pool.submit(hold)
        for _ in range(25):
            if sql("select exists(select 1 from pg_stat_activity where application_name='ventus_m3_lock_probe' and wait_event='PgSleep')::text;")=='true': break
            time.sleep(.05)
        else: raise AssertionError('Lock probe did not become ready')
        started=time.monotonic();call(a,'set_task_completion',{**versions(a,unlocked),'p_completed':True}); elapsed=time.monotonic()-started
        check('independent root is not blocked by another root lock', elapsed<2)
        job.result()
    # Soft delete completed/canceled state without erasing historical records.
    tree=create(a,doc(a,subtasks=[doc(a)]))['task_id']; tv=versions(a,tree)
    before_events=len(rows(a,'task_activity'))
    call(a,'soft_delete_task',{**tv,'p_expected_root_version':current(a,tree)[0]['version']})
    check('subtree soft deletion preserves and appends history', current(a,tree)[0]['deleted_at'] is not None and len(rows(a,'task_activity'))==before_events+2)
    denied('soft-deleted task cannot mutate', rpc(a,'cancel_task',tv))
    # Actual Auth-admin account cascade, concurrent with a normal user write.
    before_b=snapshot(b)
    with concurrent.futures.ThreadPoolExecutor(2) as pool:
        erase=pool.submit(http,'/auth/v1/admin/users/'+a['id'],None,{'should_soft_delete':False},'DELETE',True)
        write=pool.submit(rpc,a,'create_task',{'p_creation_key':str(uuid.uuid4()),'p_task':doc(a)})
        success(erase.result()); write.result()
    check('permanent Auth deletion cascades through all five tables', all(sql("select count(*) from public."+table+" where "+('user_id' if table=='user_settings' else 'owner_id')+"='"+a['id']+"';")=='0' for table in TABLES))
    check('other user unchanged by account erasure', before_b==snapshot(b))
    for table in TABLES:
        status,body=http('/rest/v1/'+table+'?select=*',a['token'])
        check('erased-user JWT cannot read data: '+table,status>=400 or body==[])
    denied('erased-user JWT cannot reinitialize orphan settings',rpc(a,'initialize_workspace',{'p_timezone':'UTC'}))
    denied('erased-user JWT cannot modify B',rpc(a,'cancel_task',versions(b,b_id)))
    USERS.remove(a)
    success(http('/auth/v1/admin/users/'+b['id'],body={'should_soft_delete':False},method='DELETE',admin=True)); USERS.remove(b)
    check('all disposable fixture personal data erased', all(sql('select count(*) from public.'+t+';')=='0' for t in TABLES))


try:
    run()
except Exception as error:
    # Never print exception objects from HTTP libraries or credentials/config.
    message=str(error) if isinstance(error, AssertionError) else type(error).__name__
    print('FAIL:',message,flush=True)
    ERRORS.append(message)
finally:
    for user in USERS:
        try:
            success(http('/auth/v1/admin/users/'+user['id'],body={'should_soft_delete':False},method='DELETE',admin=True))
        except Exception:
            print('NOTICE: disposable fixture cleanup pending; local only.',flush=True)
    report={'passed_assertions':COUNT,'failures':ERRORS,'target':'isolated localhost Supabase only','postgres_major':17}
    (ROOT/'verification-result.json').write_text(json.dumps(report,indent=2)+'\n')
    print('RESULT:',COUNT,'passed assertions;',len(ERRORS),'failure(s).',flush=True)
    sys.exit(bool(ERRORS))
