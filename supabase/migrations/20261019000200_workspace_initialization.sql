-- DRAFT / DESIGN ONLY. RPCs tested locally on PostgreSQL 17; NEVER applied hosted.
-- Depends on 001. No frontend integration, recurrence, rewards or account-delete RPC.
begin;

create function ventus_private.assert_keys(p_doc jsonb, p_allowed text[], p_required text[] default array[]::text[]) returns void
language plpgsql security invoker set search_path = '' as $$
begin
  if p_doc is null or pg_catalog.jsonb_typeof(p_doc) <> 'object' then
    raise exception using errcode = '22023', message = 'A JSON object is required';
  end if;
  if exists (select 1 from pg_catalog.jsonb_object_keys(p_doc) x(k) where k ~* 'recurr|rrule') then
    raise exception using errcode = '0A000', message = 'Recurrence is unavailable until Milestone 4';
  end if;
  if not (p_doc ?& p_required) or exists (
    select 1 from pg_catalog.jsonb_object_keys(p_doc) x(k) where not (k = any(p_allowed))) then
    raise exception using errcode = '22023', message = 'Missing, unknown or protected field';
  end if;
end;
$$;

create function ventus_private.read_slot(p_doc jsonb)
returns table (scheduled_date date, timezone text, start_time time, end_date date, end_time time, starts_at timestamptz, ends_at timestamptz)
language plpgsql security invoker set search_path = '' as $$
declare k text;
begin
  perform ventus_private.assert_keys(p_doc, array['date','timezone','start_time','end_date','end_time','starts_at','ends_at'], array['date','timezone']);
  foreach k in array array['date','timezone','start_time','end_date','end_time','starts_at','ends_at'] loop
    if p_doc ? k and pg_catalog.jsonb_typeof(p_doc->k) not in ('string','null') then
      raise exception using errcode = '22023', message = 'Schedule values must be strings or null';
    end if;
  end loop;
  if p_doc->>'date' is null or p_doc->>'date' !~ '^\d{4}-\d{2}-\d{2}$'
     or p_doc->>'timezone' is null then
    raise exception using errcode = '22023', message = 'An ISO date and explicit IANA timezone are required';
  end if;
  if p_doc->>'end_date' is not null and p_doc->>'end_date' !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception using errcode = '22023', message = 'End date must be an ISO date';
  end if;
  foreach k in array array['start_time','end_time'] loop
    if p_doc->>k is not null and p_doc->>k !~ '^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d{1,6})?)?$' then
      raise exception using errcode = '22023', message = 'Local times must be valid 24-hour times';
    end if;
  end loop;
  foreach k in array array['starts_at','ends_at'] loop
    if p_doc->>k is not null and p_doc->>k !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$' then
      raise exception using errcode = '22023', message = 'Instants require ISO timestamps with explicit UTC offsets';
    end if;
  end loop;
  scheduled_date := (p_doc->>'date')::date; timezone := p_doc->>'timezone';
  start_time := (p_doc->>'start_time')::time; end_date := (p_doc->>'end_date')::date;
  end_time := (p_doc->>'end_time')::time; starts_at := (p_doc->>'starts_at')::timestamptz; ends_at := (p_doc->>'ends_at')::timestamptz;
  perform ventus_private.validate_slot(scheduled_date, timezone, start_time, end_date, end_time, starts_at, ends_at);
  return next;
end;
$$;

create function ventus_private.validate_definition(p_doc jsonb, p_patch boolean) returns void
language plpgsql security invoker set search_path = '' as $$
declare k text;
begin
  perform ventus_private.assert_keys(p_doc, array['title','category_id','location','behavior_override','calendar_opt_in','schedule'],
    case when p_patch then array[]::text[] else array['title','category_id','schedule'] end);
  foreach k in array array['title','category_id','location','behavior_override'] loop
    if p_doc ? k and pg_catalog.jsonb_typeof(p_doc->k) not in ('string','null') then
      raise exception using errcode = '22023', message = 'Task text fields must be strings or null';
    end if;
  end loop;
  if p_doc ? 'title' and (p_doc->>'title' is null or char_length(btrim(p_doc->>'title')) not between 1 and 240) then
    raise exception using errcode = '22023', message = 'Title must contain 1 to 240 characters';
  end if;
  if p_doc ? 'category_id' and (p_doc->>'category_id' is null or p_doc->>'category_id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
    raise exception using errcode = '22023', message = 'A category UUID is required';
  end if;
  if char_length(p_doc->>'location') > 1000 or
     (p_doc->>'behavior_override' is not null and p_doc->>'behavior_override' not in ('fixed','flexible','deadline')) then
    raise exception using errcode = '22023', message = 'Invalid task location or behavior';
  end if;
  if p_doc ? 'calendar_opt_in' and pg_catalog.jsonb_typeof(p_doc->'calendar_opt_in') <> 'boolean' then
    raise exception using errcode = '22023', message = 'Calendar selection must be boolean';
  end if;
  if p_doc ? 'schedule' then perform * from ventus_private.read_slot(p_doc->'schedule'); end if;
end;
$$;

create function ventus_private.validate_new_tree(p_doc jsonb, p_depth integer default 0) returns integer
language plpgsql security invoker set search_path = '' as $$
declare n integer := 1; child jsonb;
begin
  if p_depth > 10 then raise exception using errcode = '22023', message = 'Task hierarchy is too deep'; end if;
  perform ventus_private.assert_keys(p_doc, array['title','category_id','location','behavior_override','calendar_opt_in','schedule','subtasks'], array['title','category_id','schedule']);
  perform ventus_private.validate_definition(p_doc - 'subtasks', false);
  if p_doc ? 'subtasks' and pg_catalog.jsonb_typeof(p_doc->'subtasks') <> 'array' then
    raise exception using errcode = '22023', message = 'Subtasks must be an array';
  end if;
  for child in select value from pg_catalog.jsonb_array_elements(coalesce(p_doc->'subtasks', '[]'::jsonb)) loop
    n := n + ventus_private.validate_new_tree(child, p_depth + 1);
    if n > 100 then raise exception using errcode = '22023', message = 'A command may change at most 100 tasks'; end if;
  end loop;
  return n;
end;
$$;

create function ventus_private.tree_root(p_task_id uuid) returns uuid
language sql stable security invoker set search_path = '' as $$
  with recursive ancestors as (
    select t.id, t.parent_task_id, 0 as depth from public.tasks t
      where t.owner_id = ventus_private.request_user_id() and t.id = p_task_id
    union all
    select t.id, t.parent_task_id, a.depth + 1 from public.tasks t join ancestors a on t.id = a.parent_task_id
      where t.owner_id = ventus_private.request_user_id() and a.depth < 100
  ) select id from ancestors where parent_task_id is null;
$$;

create function ventus_private.lock_tree(p_task_id uuid) returns uuid
language plpgsql security invoker set search_path = '' as $$
declare root_id uuid;
begin
  if ventus_private.request_user_id() is null then raise exception using errcode = '42501', message = 'Authentication required'; end if;
  root_id := ventus_private.tree_root(p_task_id);
  perform 1 from public.tasks t where t.owner_id = ventus_private.request_user_id() and t.id = root_id and t.deleted_at is null for update;
  if not found then raise exception using errcode = 'P0002', message = 'Task unavailable'; end if;
  perform 1 from public.tasks t where t.owner_id = ventus_private.request_user_id() and t.id = p_task_id and t.deleted_at is null;
  if not found then raise exception using errcode = 'P0002', message = 'Task unavailable'; end if;
  return root_id;
end;
$$;

create function ventus_private.check_versions(p_task_id uuid, p_task_version bigint, p_occurrence_version bigint) returns void
language plpgsql security invoker set search_path = '' as $$
declare t public.tasks%rowtype; o public.task_occurrences%rowtype;
begin
  select * into t from public.tasks where owner_id = ventus_private.request_user_id() and id = p_task_id and deleted_at is null for update;
  if not found then raise exception using errcode = 'P0002', message = 'Task unavailable'; end if;
  select * into o from public.task_occurrences where owner_id = ventus_private.request_user_id() and task_id = p_task_id and deleted_at is null for update;
  if not found then raise exception using errcode = 'P0002', message = 'Task unavailable'; end if;
  if p_task_version is null or p_occurrence_version is null or t.version <> p_task_version or o.version <> p_occurrence_version then
    raise exception using errcode = '40001', message = 'Task changed; refetch before trying again';
  end if;
  if o.recurrence_key <> 'once' then raise exception using errcode = '0A000', message = 'Recurrence is unavailable until Milestone 4'; end if;
end;
$$;

create function ventus_private.business_state(p_task_id uuid) returns jsonb
language sql stable security invoker set search_path = '' as $$
  select pg_catalog.jsonb_build_object('task', pg_catalog.to_jsonb(t) - 'creation_fingerprint' - 'creation_key', 'occurrence', pg_catalog.to_jsonb(o))
  from public.tasks t join public.task_occurrences o on o.owner_id = t.owner_id and o.task_id = t.id
  where t.owner_id = ventus_private.request_user_id() and t.id = p_task_id;
$$;

create function ventus_private.append_activity(p_task_id uuid, p_action text, p_before jsonb) returns void
language plpgsql security invoker set search_path = '' as $$
declare o public.task_occurrences%rowtype; effective timestamptz;
begin
  select * into strict o from public.task_occurrences where owner_id = ventus_private.request_user_id() and task_id = p_task_id;
  effective := case when p_action in ('completed','completion_corrected') then o.completed_at else pg_catalog.clock_timestamp() end;
  insert into public.task_activity(owner_id, task_id, occurrence_id, occurrence_version, actor_user_id, action, effective_at, before_state, after_state)
    values (ventus_private.request_user_id(), p_task_id, o.id, o.version, ventus_private.request_user_id(), p_action, effective, p_before, ventus_private.business_state(p_task_id));
end;
$$;

create function ventus_private.snapshot(p_task_id uuid) returns jsonb
language sql stable security invoker set search_path = '' as $$
  select pg_catalog.jsonb_build_object('title',t.title,'location',t.location,'category_id',c.id,'category_name',c.name,
    'behavior',coalesce(t.behavior_override,c.behavior),'calendar_opt_in',t.calendar_opt_in)
  from public.tasks t join public.categories c on c.owner_id = t.owner_id and c.id = t.category_id
  where t.owner_id = ventus_private.request_user_id() and t.id = p_task_id;
$$;

create function ventus_private.task_result(p_task_id uuid, p_root_id uuid) returns jsonb
language sql stable security invoker set search_path = '' as $$
  select pg_catalog.jsonb_build_object('task_id',t.id,'occurrence_id',o.id,'task_version',t.version,
    'occurrence_version',o.version,'root_task_id',r.id,'root_version',r.version)
  from public.tasks t join public.task_occurrences o on o.owner_id = t.owner_id and o.task_id = t.id
    join public.tasks r on r.owner_id = t.owner_id and r.id = p_root_id
  where t.owner_id = ventus_private.request_user_id() and t.id = p_task_id;
$$;

-- Top creation insert claims the retry key before any child or activity writes.
create function ventus_private.create_node(p_doc jsonb, p_parent_id uuid, p_key uuid default null, p_fingerprint bytea default null) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare c public.categories%rowtype; s record; node_id uuid; prior public.tasks%rowtype; parent_occ uuid; child jsonb;
begin
  select * into c from public.categories where owner_id = ventus_private.request_user_id() and id = (p_doc->>'category_id')::uuid and archived_at is null for share;
  if not found then raise exception using errcode = 'P0002', message = 'Category unavailable'; end if;
  select * into s from ventus_private.read_slot(p_doc->'schedule');
  insert into public.tasks(owner_id,category_id,parent_task_id,title,location,behavior_override,calendar_opt_in,creation_key,creation_fingerprint)
    values (ventus_private.request_user_id(),c.id,p_parent_id,btrim(p_doc->>'title'),p_doc->>'location',p_doc->>'behavior_override',
      coalesce((p_doc->>'calendar_opt_in')::boolean,c.calendar_default),p_key,p_fingerprint)
    on conflict (owner_id,creation_key) do nothing returning id into node_id;
  if node_id is null then
    select * into strict prior from public.tasks where owner_id = ventus_private.request_user_id() and creation_key = p_key;
    if prior.creation_fingerprint is distinct from p_fingerprint then
      raise exception using errcode = '22023', message = 'Creation key was already used for different input';
    end if;
    if prior.deleted_at is not null then raise exception using errcode = 'P0002', message = 'Task unavailable'; end if;
    return pg_catalog.jsonb_build_object('task_id',prior.id,'created',false);
  end if;
  if p_parent_id is not null then
    select id into strict parent_occ from public.task_occurrences where owner_id = ventus_private.request_user_id() and task_id = p_parent_id and deleted_at is null;
  end if;
  insert into public.task_occurrences(owner_id,task_id,parent_occurrence_id,scheduled_date,timezone,start_time,end_date,end_time,starts_at,ends_at,definition_snapshot)
    values (ventus_private.request_user_id(),node_id,parent_occ,s.scheduled_date,s.timezone,s.start_time,s.end_date,s.end_time,s.starts_at,s.ends_at,ventus_private.snapshot(node_id));
  perform ventus_private.append_activity(node_id,'created',null);
  for child in select value from pg_catalog.jsonb_array_elements(coalesce(p_doc->'subtasks','[]'::jsonb)) loop
    perform ventus_private.create_node(child,node_id);
  end loop;
  return pg_catalog.jsonb_build_object('task_id',node_id,'created',true);
end;
$$;

create function ventus_private.apply_edit(p_task_id uuid, p_patch jsonb) returns void
language plpgsql security invoker set search_path = '' as $$
declare before_doc jsonb; t public.tasks%rowtype; o public.task_occurrences%rowtype; c public.categories%rowtype; s record;
begin
  perform ventus_private.validate_definition(p_patch,true);
  if p_patch = '{}'::jsonb then raise exception using errcode = '22023', message = 'An edit must contain a change'; end if;
  select * into strict t from public.tasks where owner_id = ventus_private.request_user_id() and id = p_task_id;
  select * into strict o from public.task_occurrences where owner_id = ventus_private.request_user_id() and task_id = p_task_id;
  if o.status <> 'open' then raise exception using errcode = '22023', message = 'Reopen the task before editing its definition or schedule'; end if;
  if p_patch ? 'category_id' then
    select * into c from public.categories where owner_id = ventus_private.request_user_id() and id = (p_patch->>'category_id')::uuid and archived_at is null for share;
    if not found then raise exception using errcode = 'P0002', message = 'Category unavailable'; end if;
  else
    -- Keep archived assignments usable; lock the label while taking the snapshot.
    select * into strict c from public.categories where owner_id = ventus_private.request_user_id() and id = t.category_id for share;
  end if;
  before_doc := ventus_private.business_state(p_task_id);
  update public.tasks set title = case when p_patch ? 'title' then btrim(p_patch->>'title') else title end,
    category_id = c.id, location = case when p_patch ? 'location' then p_patch->>'location' else location end,
    behavior_override = case when p_patch ? 'behavior_override' then p_patch->>'behavior_override' else behavior_override end,
    calendar_opt_in = case when p_patch ? 'calendar_opt_in' then (p_patch->>'calendar_opt_in')::boolean else calendar_opt_in end
    where owner_id = ventus_private.request_user_id() and id = p_task_id;
  if p_patch ? 'schedule' then
    select * into s from ventus_private.read_slot(p_patch->'schedule');
    update public.task_occurrences set scheduled_date=s.scheduled_date, timezone=s.timezone, start_time=s.start_time,
      end_date=s.end_date, end_time=s.end_time, starts_at=s.starts_at, ends_at=s.ends_at, definition_snapshot=ventus_private.snapshot(p_task_id)
      where owner_id=ventus_private.request_user_id() and task_id=p_task_id;
  else
    update public.task_occurrences set definition_snapshot=ventus_private.snapshot(p_task_id) where owner_id=ventus_private.request_user_id() and task_id=p_task_id;
  end if;
  perform ventus_private.append_activity(p_task_id,'edited',before_doc);
end;
$$;

create function ventus_private.soft_delete_subtree(p_task_id uuid) returns integer
language plpgsql security invoker set search_path = '' as $$
declare node record; before_doc jsonb; n integer := 0; total integer;
begin
  with recursive branch as (
    select id from public.tasks where owner_id=ventus_private.request_user_id() and id=p_task_id and deleted_at is null
    union all select t.id from public.tasks t join branch b on t.parent_task_id=b.id where t.owner_id=ventus_private.request_user_id() and t.deleted_at is null
  ) select count(*) into total from branch;
  if total > 100 then raise exception using errcode='22023', message='A command may change at most 100 tasks'; end if;
  for node in with recursive branch as (
    select id,0 as depth from public.tasks where owner_id=ventus_private.request_user_id() and id=p_task_id and deleted_at is null
    union all select t.id,b.depth+1 from public.tasks t join branch b on t.parent_task_id=b.id where t.owner_id=ventus_private.request_user_id() and t.deleted_at is null
  ) select id from branch order by depth desc,id loop
    before_doc := ventus_private.business_state(node.id);
    update public.tasks set deleted_at=pg_catalog.clock_timestamp() where owner_id=ventus_private.request_user_id() and id=node.id;
    update public.task_occurrences set deleted_at=pg_catalog.clock_timestamp() where owner_id=ventus_private.request_user_id() and task_id=node.id;
    perform ventus_private.append_activity(node.id,'deleted',before_doc);
    n := n + 1;
  end loop;
  return n;
end;
$$;

create function public.initialize_workspace(p_timezone text) returns void
language plpgsql security definer set search_path = '' set row_security = on as $$
declare actor uuid := ventus_private.request_user_id(); initialized timestamptz;
begin
  if actor is null then raise exception using errcode='42501', message='Authentication required'; end if;
  if not ventus_private.valid_timezone(p_timezone) then raise exception using errcode='22023', message='A supported IANA timezone is required'; end if;
  insert into public.user_settings(user_id,timezone) values(actor,p_timezone) on conflict(user_id) do nothing;
  -- The only explicit workspace-wide lock: one-time initialization, not task writes.
  select defaults_initialized_at into initialized from public.user_settings where user_id=actor for update;
  if initialized is not null then return; end if;
  insert into public.categories(owner_id,seed_key,name,behavior,calendar_default) values
    (actor,'classes','Classes','fixed',true),(actor,'meetings','Meetings','fixed',true),
    (actor,'assignments','Assignments','deadline',true),(actor,'professional','Professional Events','fixed',true),
    (actor,'social','Social Events','fixed',true),(actor,'personal','Personal Tasks','flexible',false),
    (actor,'misc','Miscellaneous','flexible',false);
  update public.user_settings set defaults_initialized_at=pg_catalog.clock_timestamp() where user_id=actor;
end;
$$;

create function public.update_settings(p_expected_version bigint,p_timezone text,p_appearance text) returns bigint
language plpgsql security definer set search_path = '' set row_security = on as $$
declare result_version bigint;
begin
  if ventus_private.request_user_id() is null then raise exception using errcode='42501', message='Authentication required'; end if;
  update public.user_settings set timezone=p_timezone,appearance=p_appearance
    where user_id=ventus_private.request_user_id() and version=p_expected_version returning version into result_version;
  if not found then raise exception using errcode='40001', message='Settings changed or unavailable; refetch'; end if;
  return result_version;
end;
$$;

create function public.create_category(p_name text,p_behavior text,p_calendar_default boolean) returns uuid
language plpgsql security definer set search_path = '' set row_security = on as $$
declare category_id uuid;
begin
  if ventus_private.request_user_id() is null then raise exception using errcode='42501', message='Authentication required'; end if;
  insert into public.categories(owner_id,name,behavior,calendar_default) values(ventus_private.request_user_id(),btrim(p_name),p_behavior,p_calendar_default) returning id into category_id;
  return category_id;
end;
$$;

create function public.update_category(p_category_id uuid,p_expected_version bigint,p_name text,p_behavior text,p_calendar_default boolean,p_archived boolean) returns bigint
language plpgsql security definer set search_path = '' set row_security = on as $$
declare result_version bigint;
begin
  if ventus_private.request_user_id() is null then raise exception using errcode='42501', message='Authentication required'; end if;
  if p_archived is null then raise exception using errcode='22023', message='Archive selection is required'; end if;
  update public.categories set name=btrim(p_name),behavior=p_behavior,calendar_default=p_calendar_default,
    archived_at=case when p_archived then coalesce(archived_at,pg_catalog.clock_timestamp()) else null end
    where owner_id=ventus_private.request_user_id() and id=p_category_id and version=p_expected_version returning version into result_version;
  if not found then raise exception using errcode='40001', message='Category changed or unavailable; refetch'; end if;
  return result_version;
end;
$$;

create function public.create_task(p_creation_key uuid,p_task jsonb,p_parent_task_id uuid default null,
  p_expected_parent_version bigint default null,p_expected_parent_occurrence_version bigint default null) returns jsonb
language plpgsql security definer set search_path = '' set row_security = on as $$
declare root_id uuid; node_id uuid; fingerprint bytea; prior public.tasks%rowtype; created_doc jsonb;
begin
  if ventus_private.request_user_id() is null then raise exception using errcode='42501', message='Authentication required'; end if;
  if p_creation_key is null or p_task is null or pg_catalog.octet_length(p_task::text) > 65536 then
    raise exception using errcode='22023', message='Creation key and a bounded task payload are required';
  end if;
  perform ventus_private.validate_new_tree(p_task);
  fingerprint := pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object('task',p_task,'parent_task_id',p_parent_task_id)::text,'UTF8'));
  select * into prior from public.tasks where owner_id=ventus_private.request_user_id() and creation_key=p_creation_key;
  if found then
    if prior.creation_fingerprint is distinct from fingerprint then raise exception using errcode='22023', message='Creation key was already used for different input'; end if;
    root_id := ventus_private.lock_tree(prior.id);
    return ventus_private.task_result(prior.id,root_id) || pg_catalog.jsonb_build_object('created',false);
  end if;
  if p_parent_task_id is not null then
    root_id := ventus_private.lock_tree(p_parent_task_id);
    -- A concurrent identical creation may have committed while we waited for root.
    select * into prior from public.tasks where owner_id=ventus_private.request_user_id() and creation_key=p_creation_key;
    if found then
      if prior.creation_fingerprint is distinct from fingerprint then raise exception using errcode='22023', message='Creation key was already used for different input'; end if;
      if prior.deleted_at is not null then raise exception using errcode='P0002', message='Task unavailable'; end if;
      return ventus_private.task_result(prior.id,root_id) || pg_catalog.jsonb_build_object('created',false);
    end if;
    perform ventus_private.check_versions(p_parent_task_id,p_expected_parent_version,p_expected_parent_occurrence_version);
  elsif p_expected_parent_version is not null or p_expected_parent_occurrence_version is not null then
    raise exception using errcode='22023', message='Parent versions require a parent task';
  end if;
  created_doc := ventus_private.create_node(p_task,p_parent_task_id,p_creation_key,fingerprint);
  node_id := (created_doc->>'task_id')::uuid;
  if root_id is null then root_id := ventus_private.lock_tree(node_id); end if;
  if (created_doc->>'created')::boolean and root_id <> node_id then
    update public.tasks set updated_at=pg_catalog.clock_timestamp() where owner_id=ventus_private.request_user_id() and id=root_id;
  end if;
  return ventus_private.task_result(node_id,root_id) || pg_catalog.jsonb_build_object('created',(created_doc->>'created')::boolean);
end;
$$;

-- One hierarchy per command. Existing patches + new dated subtrees + explicit
-- removals commit atomically. Omitted children are never implicitly deleted.
create function public.edit_task_tree(p_root_task_id uuid,p_expected_root_version bigint,p_edits jsonb,
  p_new_subtasks jsonb default '[]'::jsonb,p_delete_subtasks jsonb default '[]'::jsonb) returns jsonb
language plpgsql security definer set search_path = '' set row_security = on as $$
declare root_id uuid; item jsonb; task_id uuid; parent_id uuid; total integer:=0; changed uuid[]:=array[]::uuid[];
  removed uuid[]:=array[]::uuid[]; inserted jsonb:='[]'::jsonb; created_doc jsonb; node record;
begin
  if ventus_private.request_user_id() is null then raise exception using errcode='42501', message='Authentication required'; end if;
  if p_edits is null or p_new_subtasks is null or p_delete_subtasks is null
     or pg_catalog.jsonb_typeof(p_edits)<>'array' or pg_catalog.jsonb_typeof(p_new_subtasks)<>'array' or pg_catalog.jsonb_typeof(p_delete_subtasks)<>'array'
     or pg_catalog.octet_length(pg_catalog.jsonb_build_array(p_edits,p_new_subtasks,p_delete_subtasks)::text)>65536 then
    raise exception using errcode='22023', message='Bounded edit, addition and removal arrays are required';
  end if;
  if pg_catalog.jsonb_array_length(p_edits)+pg_catalog.jsonb_array_length(p_new_subtasks)+pg_catalog.jsonb_array_length(p_delete_subtasks)>100 then
    raise exception using errcode='22023', message='A command may change at most 100 tasks';
  end if;
  root_id := ventus_private.lock_tree(p_root_task_id);
  if root_id <> p_root_task_id then raise exception using errcode='22023', message='Supply the hierarchy root'; end if;
  if p_expected_root_version is null or not exists(select 1 from public.tasks where owner_id=ventus_private.request_user_id() and id=root_id and version=p_expected_root_version) then
    raise exception using errcode='40001', message='Task hierarchy changed; refetch';
  end if;
  -- Validate all preconditions before touching rows. Each target appears once.
  for item in select value from pg_catalog.jsonb_array_elements(p_edits) loop
    perform ventus_private.assert_keys(item,array['task_id','task_version','occurrence_version','patch'],array['task_id','task_version','occurrence_version','patch']);
    task_id := (item->>'task_id')::uuid;
    if task_id is null or task_id=any(changed) or ventus_private.tree_root(task_id) is distinct from root_id then
      raise exception using errcode='22023', message='Edit target unavailable or repeated';
    end if;
    perform ventus_private.check_versions(task_id,(item->>'task_version')::bigint,(item->>'occurrence_version')::bigint);
    perform ventus_private.validate_definition(item->'patch',true);
    changed := pg_catalog.array_append(changed,task_id); total := total+1;
  end loop;
  for item in select value from pg_catalog.jsonb_array_elements(p_delete_subtasks) loop
    perform ventus_private.assert_keys(item,array['task_id','task_version','occurrence_version'],array['task_id','task_version','occurrence_version']);
    task_id := (item->>'task_id')::uuid;
    if task_id is null or task_id=root_id or ventus_private.tree_root(task_id) is distinct from root_id then
      raise exception using errcode='22023', message='Removal target unavailable';
    end if;
    perform ventus_private.check_versions(task_id,(item->>'task_version')::bigint,(item->>'occurrence_version')::bigint);
    for node in with recursive branch as (
      select t.id from public.tasks t where t.owner_id=ventus_private.request_user_id() and t.id=task_id and t.deleted_at is null
      union all select t.id from public.tasks t join branch b on t.parent_task_id=b.id where t.owner_id=ventus_private.request_user_id() and t.deleted_at is null
    ) select id from branch loop
      if node.id=any(changed) or node.id=any(removed) then raise exception using errcode='22023', message='Edit and removal scopes must not overlap'; end if;
      removed:=pg_catalog.array_append(removed,node.id); total:=total+1;
      if total>100 then raise exception using errcode='22023', message='A command may change at most 100 tasks'; end if;
    end loop;
  end loop;
  for item in select value from pg_catalog.jsonb_array_elements(p_new_subtasks) loop
    perform ventus_private.assert_keys(item,array['parent_task_id','task'],array['parent_task_id','task']);
    parent_id := (item->>'parent_task_id')::uuid;
    if parent_id is null or ventus_private.tree_root(parent_id) is distinct from root_id or parent_id=any(removed)
       or not exists(select 1 from public.tasks t where t.owner_id=ventus_private.request_user_id() and t.id=parent_id and t.deleted_at is null) then
      raise exception using errcode='P0002', message='Parent task unavailable';
    end if;
    total:=total+ventus_private.validate_new_tree(item->'task');
  end loop;
  if total=0 or total>100 then raise exception using errcode='22023', message='A command must change 1 to 100 tasks'; end if;
  for item in select value from pg_catalog.jsonb_array_elements(p_edits) order by value->>'task_id' loop
    perform ventus_private.apply_edit((item->>'task_id')::uuid,item->'patch');
  end loop;
  for item in select value from pg_catalog.jsonb_array_elements(p_new_subtasks) loop
    created_doc:=ventus_private.create_node(item->'task',(item->>'parent_task_id')::uuid);
    inserted:=inserted || pg_catalog.jsonb_build_array(created_doc->'task_id');
  end loop;
  for item in select value from pg_catalog.jsonb_array_elements(p_delete_subtasks) loop
    perform ventus_private.soft_delete_subtree((item->>'task_id')::uuid);
  end loop;
  if not (root_id=any(changed)) then update public.tasks set updated_at=pg_catalog.clock_timestamp() where owner_id=ventus_private.request_user_id() and id=root_id; end if;
  return ventus_private.task_result(root_id,root_id) || pg_catalog.jsonb_build_object('new_task_ids',inserted,'changed_task_count',total);
end;
$$;

create function public.set_task_completion(p_task_id uuid,p_expected_task_version bigint,p_expected_occurrence_version bigint,
  p_completed boolean,p_actual_completed_at timestamptz default null) returns jsonb
language plpgsql security definer set search_path = '' set row_security = on as $$
declare root_id uuid; o public.task_occurrences%rowtype; before_doc jsonb; actual timestamptz; event_action text;
begin
  if ventus_private.request_user_id() is null then raise exception using errcode='42501', message='Authentication required'; end if;
  root_id:=ventus_private.lock_tree(p_task_id);
  perform ventus_private.check_versions(p_task_id,p_expected_task_version,p_expected_occurrence_version);
  select * into strict o from public.task_occurrences where owner_id=ventus_private.request_user_id() and task_id=p_task_id;
  if p_completed is null or o.status='canceled' then raise exception using errcode='22023', message='Invalid completion transition'; end if;
  if not p_completed and p_actual_completed_at is not null then raise exception using errcode='22023', message='Reopening must not supply a completion timestamp'; end if;
  actual:=case when p_completed then coalesce(p_actual_completed_at,case when o.status='completed' then o.completed_at else pg_catalog.clock_timestamp() end) else null end;
  if actual is not null and (not pg_catalog.isfinite(actual) or actual>pg_catalog.clock_timestamp()) then
    raise exception using errcode='22023', message='Actual completion cannot be in the future';
  end if;
  if (p_completed and o.status='completed' and actual=o.completed_at) or (not p_completed and o.status='open') then
    return ventus_private.task_result(p_task_id,root_id); -- desired state already holds; no history/version write
  end if;
  event_action:=case when not p_completed then 'reopened' when o.status='completed' then 'completion_corrected' else 'completed' end;
  before_doc:=ventus_private.business_state(p_task_id);
  update public.tasks set updated_at=pg_catalog.clock_timestamp() where owner_id=ventus_private.request_user_id() and id=p_task_id;
  update public.task_occurrences set status=case when p_completed then 'completed' else 'open' end,completed_at=actual where owner_id=ventus_private.request_user_id() and task_id=p_task_id;
  perform ventus_private.append_activity(p_task_id,event_action,before_doc);
  if root_id<>p_task_id then update public.tasks set updated_at=pg_catalog.clock_timestamp() where owner_id=ventus_private.request_user_id() and id=root_id; end if;
  return ventus_private.task_result(p_task_id,root_id);
end;
$$;

create function public.postpone_task(p_task_id uuid,p_expected_task_version bigint,p_expected_occurrence_version bigint,p_schedule jsonb) returns jsonb
language plpgsql security definer set search_path = '' set row_security = on as $$
declare root_id uuid; before_doc jsonb; s record;
begin
  if ventus_private.request_user_id() is null then raise exception using errcode='42501', message='Authentication required'; end if;
  if p_schedule is null or pg_catalog.octet_length(p_schedule::text)>4096 then raise exception using errcode='22023', message='A bounded schedule is required'; end if;
  root_id:=ventus_private.lock_tree(p_task_id);
  perform ventus_private.check_versions(p_task_id,p_expected_task_version,p_expected_occurrence_version);
  if not exists(select 1 from public.task_occurrences where owner_id=ventus_private.request_user_id() and task_id=p_task_id and status='open') then
    raise exception using errcode='22023', message='Only open tasks can be postponed';
  end if;
  select * into s from ventus_private.read_slot(p_schedule);
  before_doc:=ventus_private.business_state(p_task_id);
  update public.tasks set updated_at=pg_catalog.clock_timestamp() where owner_id=ventus_private.request_user_id() and id=p_task_id;
  update public.task_occurrences set scheduled_date=s.scheduled_date,timezone=s.timezone,start_time=s.start_time,
    end_date=s.end_date,end_time=s.end_time,starts_at=s.starts_at,ends_at=s.ends_at where owner_id=ventus_private.request_user_id() and task_id=p_task_id;
  perform ventus_private.append_activity(p_task_id,'postponed',before_doc);
  if root_id<>p_task_id then update public.tasks set updated_at=pg_catalog.clock_timestamp() where owner_id=ventus_private.request_user_id() and id=root_id; end if;
  return ventus_private.task_result(p_task_id,root_id);
end;
$$;

create function public.cancel_task(p_task_id uuid,p_expected_task_version bigint,p_expected_occurrence_version bigint,p_reason text default null) returns jsonb
language plpgsql security definer set search_path = '' set row_security = on as $$
declare root_id uuid; before_doc jsonb;
begin
  if ventus_private.request_user_id() is null then raise exception using errcode='42501', message='Authentication required'; end if;
  if char_length(p_reason)>500 then raise exception using errcode='22023', message='Cancellation reason is too long'; end if;
  root_id:=ventus_private.lock_tree(p_task_id);
  perform ventus_private.check_versions(p_task_id,p_expected_task_version,p_expected_occurrence_version);
  if not exists(select 1 from public.task_occurrences where owner_id=ventus_private.request_user_id() and task_id=p_task_id and status='open') then
    raise exception using errcode='22023', message='Only open tasks can be canceled';
  end if;
  before_doc:=ventus_private.business_state(p_task_id);
  update public.tasks set updated_at=pg_catalog.clock_timestamp() where owner_id=ventus_private.request_user_id() and id=p_task_id;
  update public.task_occurrences set status='canceled',cancellation_reason=p_reason where owner_id=ventus_private.request_user_id() and task_id=p_task_id;
  perform ventus_private.append_activity(p_task_id,'canceled',before_doc);
  if root_id<>p_task_id then update public.tasks set updated_at=pg_catalog.clock_timestamp() where owner_id=ventus_private.request_user_id() and id=root_id; end if;
  return ventus_private.task_result(p_task_id,root_id);
end;
$$;

create function public.soft_delete_task(p_task_id uuid,p_expected_task_version bigint,p_expected_occurrence_version bigint,p_expected_root_version bigint) returns jsonb
language plpgsql security definer set search_path = '' set row_security = on as $$
declare root_id uuid; n integer;
begin
  if ventus_private.request_user_id() is null then raise exception using errcode='42501', message='Authentication required'; end if;
  root_id:=ventus_private.lock_tree(p_task_id);
  perform ventus_private.check_versions(p_task_id,p_expected_task_version,p_expected_occurrence_version);
  if p_expected_root_version is null or not exists(select 1 from public.tasks where owner_id=ventus_private.request_user_id() and id=root_id and version=p_expected_root_version) then
    raise exception using errcode='40001', message='Task hierarchy changed; refetch';
  end if;
  n:=ventus_private.soft_delete_subtree(p_task_id);
  if root_id<>p_task_id then update public.tasks set updated_at=pg_catalog.clock_timestamp() where owner_id=ventus_private.request_user_id() and id=root_id; end if;
  return ventus_private.task_result(p_task_id,root_id) || pg_catalog.jsonb_build_object('deleted_task_count',n);
end;
$$;

-- Explicit ownership/grants, limited to functions created by this migration.
-- No dynamic SQL and no grants affecting unrelated existing public functions.
grant create on schema public to ventus_writer;
revoke all on function public.initialize_workspace(text) from public, anon, authenticated, service_role;
alter function public.initialize_workspace(text) owner to ventus_writer;
grant execute on function public.initialize_workspace(text) to authenticated;
revoke all on function public.update_settings(bigint,text,text) from public, anon, authenticated, service_role;
alter function public.update_settings(bigint,text,text) owner to ventus_writer;
grant execute on function public.update_settings(bigint,text,text) to authenticated;
revoke all on function public.create_category(text,text,boolean) from public, anon, authenticated, service_role;
alter function public.create_category(text,text,boolean) owner to ventus_writer;
grant execute on function public.create_category(text,text,boolean) to authenticated;
revoke all on function public.update_category(uuid,bigint,text,text,boolean,boolean) from public, anon, authenticated, service_role;
alter function public.update_category(uuid,bigint,text,text,boolean,boolean) owner to ventus_writer;
grant execute on function public.update_category(uuid,bigint,text,text,boolean,boolean) to authenticated;
revoke all on function public.create_task(uuid,jsonb,uuid,bigint,bigint) from public, anon, authenticated, service_role;
alter function public.create_task(uuid,jsonb,uuid,bigint,bigint) owner to ventus_writer;
grant execute on function public.create_task(uuid,jsonb,uuid,bigint,bigint) to authenticated;
revoke all on function public.edit_task_tree(uuid,bigint,jsonb,jsonb,jsonb) from public, anon, authenticated, service_role;
alter function public.edit_task_tree(uuid,bigint,jsonb,jsonb,jsonb) owner to ventus_writer;
grant execute on function public.edit_task_tree(uuid,bigint,jsonb,jsonb,jsonb) to authenticated;
revoke all on function public.set_task_completion(uuid,bigint,bigint,boolean,timestamptz) from public, anon, authenticated, service_role;
alter function public.set_task_completion(uuid,bigint,bigint,boolean,timestamptz) owner to ventus_writer;
grant execute on function public.set_task_completion(uuid,bigint,bigint,boolean,timestamptz) to authenticated;
revoke all on function public.postpone_task(uuid,bigint,bigint,jsonb) from public, anon, authenticated, service_role;
alter function public.postpone_task(uuid,bigint,bigint,jsonb) owner to ventus_writer;
grant execute on function public.postpone_task(uuid,bigint,bigint,jsonb) to authenticated;
revoke all on function public.cancel_task(uuid,bigint,bigint,text) from public, anon, authenticated, service_role;
alter function public.cancel_task(uuid,bigint,bigint,text) owner to ventus_writer;
grant execute on function public.cancel_task(uuid,bigint,bigint,text) to authenticated;
revoke all on function public.soft_delete_task(uuid,bigint,bigint,bigint) from public, anon, authenticated, service_role;
alter function public.soft_delete_task(uuid,bigint,bigint,bigint) owner to ventus_writer;
grant execute on function public.soft_delete_task(uuid,bigint,bigint,bigint) to authenticated;
revoke create on schema public from ventus_writer;
revoke all on all functions in schema ventus_private from public, anon, authenticated, service_role;
grant execute on all functions in schema ventus_private to ventus_writer;
commit;
