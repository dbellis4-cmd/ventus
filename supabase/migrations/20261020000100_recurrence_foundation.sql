-- Milestone 4 recurrence foundation. Apply only after the existing two migrations.
begin;

grant create on schema public to ventus_writer;

alter table public.tasks add column recurrence_enabled boolean not null default false;
alter table public.task_occurrences add column is_exception boolean not null default false;
create index task_occurrences_recent_completion_idx on public.task_occurrences(owner_id,completed_at,id)
  where status='completed' and deleted_at is null;
alter table public.task_occurrences drop constraint task_occurrences_recurrence_key_check;
alter table public.task_occurrences add constraint task_occurrences_recurrence_key_check
  check (recurrence_key = 'once' or recurrence_key ~ '^\d{4}-\d{2}-\d{2}$');

create table public.task_recurrence_revisions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.user_settings(user_id) on delete cascade,
  task_id uuid not null,
  revision integer not null check (revision > 0),
  effective_from date not null,
  effective_until date,
  rule_end_date date,
  anchor_date date not null,
  frequency text not null check (frequency in ('daily','weekly','monthly','yearly','weekdays')),
  weekdays integer[] not null default '{}',
  timezone text not null,
  start_time time without time zone,
  end_time time without time zone,
  end_day_offset integer not null default 0 check (end_day_offset between 0 and 7),
  fold_side text not null default 'earlier' check (fold_side in ('earlier','later')),
  definition_snapshot jsonb not null check (jsonb_typeof(definition_snapshot) = 'object'),
  child_templates jsonb not null default '[]'::jsonb check (jsonb_typeof(child_templates) = 'array'),
  stopped boolean not null default false,
  recorded_at timestamptz not null default statement_timestamp(),
  actor_user_id uuid not null,
  unique (owner_id, task_id, revision),
  check (effective_until is null or effective_until >= effective_from),
  check (rule_end_date is null or rule_end_date >= effective_from),
  check ((frequency = 'weekdays' and cardinality(weekdays) between 1 and 7 and weekdays <@ array[0,1,2,3,4,5,6])
    or (frequency <> 'weekdays' and weekdays = '{}')),
  check ((start_time is null and end_time is null and end_day_offset = 0) or start_time is not null),
  check (actor_user_id = owner_id),
  foreign key (owner_id, task_id) references public.tasks(owner_id, id) on delete no action deferrable initially deferred
);
create index task_recurrence_revisions_window_idx
  on public.task_recurrence_revisions(owner_id, effective_from, effective_until, task_id);

alter table public.task_recurrence_revisions enable row level security;
alter table public.task_recurrence_revisions force row level security;
revoke all on public.task_recurrence_revisions from public, anon, authenticated, service_role;
grant select on public.task_recurrence_revisions to authenticated, ventus_writer;
grant insert, update on public.task_recurrence_revisions to ventus_writer;
create policy recurrence_read on public.task_recurrence_revisions for select to authenticated, ventus_writer
  using ((select auth.uid()) = owner_id);
create policy recurrence_insert on public.task_recurrence_revisions for insert to ventus_writer
  with check ((select auth.uid()) = owner_id);
create policy recurrence_update on public.task_recurrence_revisions for update to ventus_writer
  using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);

-- Calendar date matching is shared by read expansion and mutation validation.
create function ventus_private.recurrence_matches(p_frequency text, p_anchor date, p_day date, p_weekdays integer[])
returns boolean language sql immutable security invoker set search_path = '' as $$
  select p_day >= p_anchor and case p_frequency
    when 'daily' then true
    when 'weekly' then (p_day - p_anchor) % 7 = 0
    when 'monthly' then extract(day from p_day) = extract(day from p_anchor)
    when 'yearly' then extract(month from p_day) = extract(month from p_anchor)
      and extract(day from p_day) = extract(day from p_anchor)
    when 'weekdays' then extract(dow from p_day)::integer = any(p_weekdays)
    else false end;
$$;

-- An instant is selected from the possible offsets around its local day. A DST
-- gap yields NULL; a fold uses the revision's explicit side.
create function ventus_private.recurrence_instant(p_day date, p_time time, p_zone text, p_side text)
returns timestamptz language sql stable security invoker set search_path = '' as $$
  with local_time as (select p_day + p_time as wall),
  offsets as (
    select distinct ((sample at time zone p_zone) - (sample at time zone 'UTC')) as delta
    from local_time, lateral pg_catalog.generate_series(
      (wall at time zone 'UTC') - interval '36 hours',
      (wall at time zone 'UTC') + interval '36 hours', interval '6 hours') sample
  ), candidates as (
    select (wall - delta) at time zone 'UTC' as instant from local_time, offsets
    where ((wall - delta) at time zone 'UTC') at time zone p_zone = wall
  )
  select case when p_side = 'later' then max(instant) else min(instant) end from candidates;
$$;

create function ventus_private.recurrence_revision(p_task_id uuid, p_key date)
returns public.task_recurrence_revisions language sql stable security invoker set search_path = '' as $$
  select r from public.task_recurrence_revisions r
  where r.owner_id = ventus_private.request_user_id() and r.task_id = p_task_id
    and r.effective_from <= p_key and (r.effective_until is null or p_key < r.effective_until)
    and (r.rule_end_date is null or p_key <= r.rule_end_date)
    and not r.stopped
    and ventus_private.recurrence_matches(r.frequency, r.anchor_date, p_key, r.weekdays)
  order by r.revision desc limit 1;
$$;

create or replace function ventus_private.guard_occurrence() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare t public.tasks%rowtype; parent_task uuid;
begin
  select * into strict t from public.tasks where owner_id = new.owner_id and id = new.task_id;
  if tg_op = 'INSERT' then
    if new.recurrence_key <> 'once' and
       (not t.recurrence_enabled or new.recurrence_key::date is null) then
      raise exception using errcode='0A000', message='Invalid recurring occurrence';
    end if;
    new.original_date := new.scheduled_date; new.original_timezone := new.timezone;
    new.original_start_time := new.start_time; new.original_end_date := new.end_date;
    new.original_end_time := new.end_time; new.original_starts_at := new.starts_at;
    new.original_ends_at := new.ends_at;
  else
    if (new.task_id, new.recurrence_key, new.parent_occurrence_id, new.original_date, new.original_timezone,
        new.original_start_time, new.original_end_date, new.original_end_time, new.original_starts_at, new.original_ends_at)
       is distinct from
       (old.task_id, old.recurrence_key, old.parent_occurrence_id, old.original_date, old.original_timezone,
        old.original_start_time, old.original_end_date, old.original_end_time, old.original_starts_at, old.original_ends_at) then
      raise exception using errcode='42501', message='Original occurrence identity and deadline are immutable';
    end if;
    if old.status <> 'open' and new.definition_snapshot is distinct from old.definition_snapshot then
      raise exception using errcode='42501', message='Closed occurrence snapshots cannot be rewritten';
    end if;
  end if;
  parent_task := t.parent_task_id;
  if parent_task is null and new.parent_occurrence_id is not null then
    raise exception using errcode='23514', message='Root occurrence cannot have a parent';
  end if;
  if parent_task is not null then
    if new.recurrence_key = 'once' and
       (new.parent_occurrence_id is null or not exists(
         select 1 from public.task_occurrences p where p.owner_id=new.owner_id
           and p.id=new.parent_occurrence_id and p.task_id=parent_task)) then
      raise exception using errcode='23514', message='Subtask must reference its parent occurrence';
    end if;
    if new.recurrence_key <> 'once' and
       (new.parent_occurrence_id is not null or not exists(
         select 1 from public.tasks p where p.owner_id=new.owner_id and p.id=parent_task
           and p.recurrence_enabled and p.deleted_at is null)) then
      raise exception using errcode='23514', message='Recurring subtask must use its parent key';
    end if;
  end if;
  perform ventus_private.validate_slot(new.scheduled_date,new.timezone,new.start_time,new.end_date,
    new.end_time,new.starts_at,new.ends_at);
  if new.status='completed' then
    if tg_op='INSERT' or old.status<>'completed' or new.completed_at is distinct from old.completed_at then
      new.completion_recorded_at:=pg_catalog.clock_timestamp();
    else new.completion_recorded_at:=old.completion_recorded_at; end if;
  else new.completion_recorded_at:=null; end if;
  if new.status='canceled' then
    if tg_op='INSERT' or old.status<>'canceled' then new.canceled_at:=pg_catalog.clock_timestamp();
    else new.canceled_at:=old.canceled_at; end if;
  else new.canceled_at:=null; new.cancellation_reason:=null; end if;
  return new;
end;
$$;

-- Existing one-time functions must not choose an arbitrary row from a series.
create or replace function ventus_private.check_versions(p_task_id uuid, p_task_version bigint, p_occurrence_version bigint) returns void
language plpgsql security invoker set search_path = '' as $$
declare t public.tasks%rowtype; o public.task_occurrences%rowtype;
begin
  select * into t from public.tasks where owner_id = ventus_private.request_user_id() and id = p_task_id and deleted_at is null for update;
  if not found then raise exception using errcode = 'P0002', message = 'Task unavailable'; end if;
  if t.recurrence_enabled then raise exception using errcode = '0A000', message = 'Use an occurrence-specific operation'; end if;
  select * into o from public.task_occurrences where owner_id = ventus_private.request_user_id() and task_id = p_task_id and deleted_at is null for update;
  if not found then raise exception using errcode = 'P0002', message = 'Task unavailable'; end if;
  if p_task_version is null or p_occurrence_version is null or t.version <> p_task_version or o.version <> p_occurrence_version then
    raise exception using errcode = '40001', message = 'Task changed; refetch before trying again';
  end if;
  if o.recurrence_key <> 'once' then raise exception using errcode = '0A000', message = 'Use an occurrence-specific operation'; end if;
end;
$$;

-- Legacy child creation must not add a one-time node anywhere inside a series.
create or replace function ventus_private.create_node(p_doc jsonb, p_parent_id uuid, p_key uuid default null, p_fingerprint bytea default null) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare c public.categories%rowtype; s record; node_id uuid; prior public.tasks%rowtype; parent_occ uuid; child jsonb;
begin
  if p_parent_id is not null and exists (
    select 1 from public.tasks root where root.owner_id = ventus_private.request_user_id()
      and root.id = ventus_private.tree_root(p_parent_id) and root.recurrence_enabled
  ) then
    raise exception using errcode = '0A000', message = 'Use the recurring series operation';
  end if;
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

create function ventus_private.read_recurrence_rule(p_rule jsonb)
returns table(frequency text, weekdays integer[], end_date date, fold_side text)
language plpgsql security invoker set search_path = '' as $$
declare day_value jsonb;
begin
  perform ventus_private.assert_keys(p_rule,
    array['frequency','weekdays','end_date','fold_side'],
    array['frequency','weekdays','end_date','fold_side']);
  frequency:=p_rule->>'frequency';
  fold_side:=p_rule->>'fold_side';
  if frequency not in ('daily','weekly','monthly','yearly','weekdays') or
     fold_side not in ('earlier','later') or
     pg_catalog.jsonb_typeof(p_rule->'weekdays')<>'array' or
     pg_catalog.jsonb_array_length(p_rule->'weekdays')>7 then
    raise exception using errcode='22023', message='Invalid recurrence rule';
  end if;
  weekdays:=array[]::integer[];
  for day_value in select value from pg_catalog.jsonb_array_elements(p_rule->'weekdays') loop
    if pg_catalog.jsonb_typeof(day_value)<>'number' or day_value::text !~ '^[0-6]$'
       or (day_value::text)::integer=any(weekdays) then
      raise exception using errcode='22023', message='Invalid recurrence weekdays';
    end if;
    weekdays:=pg_catalog.array_append(weekdays,(day_value::text)::integer);
  end loop;
  if (frequency='weekdays' and cardinality(weekdays)=0) or
     (frequency<>'weekdays' and cardinality(weekdays)<>0) then
    raise exception using errcode='22023', message='Invalid recurrence weekdays';
  end if;
  if pg_catalog.jsonb_typeof(p_rule->'end_date')='null' then end_date:=null;
  elsif pg_catalog.jsonb_typeof(p_rule->'end_date')='string' and
        p_rule->>'end_date' ~ '^\d{4}-\d{2}-\d{2}$' then
    end_date:=(p_rule->>'end_date')::date;
  else raise exception using errcode='22023', message='Invalid recurrence end date';
  end if;
  return next;
end;
$$;

create function public.create_recurring_task(p_creation_key uuid,p_task jsonb,p_rule jsonb)
returns jsonb language plpgsql security definer set search_path = '' set row_security = on as $$
declare actor uuid:=ventus_private.request_user_id(); s record; rule record; c public.categories%rowtype;
  node_id uuid; child_id uuid; prior public.tasks%rowtype; child jsonb; child_slot record;
  templates jsonb:='[]'::jsonb; fingerprint bytea;
begin
  if actor is null then raise exception using errcode='42501', message='Authentication required'; end if;
  if p_creation_key is null or p_task is null or p_rule is null or
     pg_catalog.octet_length(pg_catalog.jsonb_build_array(p_task,p_rule)::text)>65536 then
    raise exception using errcode='22023', message='A bounded recurring task is required';
  end if;
  perform ventus_private.validate_new_tree(p_task);
  select * into strict s from ventus_private.read_slot(p_task->'schedule');
  select * into strict rule from ventus_private.read_recurrence_rule(p_rule);
  if s.scheduled_date < (pg_catalog.clock_timestamp() at time zone s.timezone)::date or
     (rule.end_date is not null and rule.end_date<s.scheduled_date) or
     not ventus_private.recurrence_matches(rule.frequency,s.scheduled_date,s.scheduled_date,rule.weekdays) or
     (s.end_date is not null and s.end_date-s.scheduled_date>7) then
    raise exception using errcode='22023', message='Recurring start and end dates are invalid';
  end if;
  if s.start_time is not null and s.starts_at is distinct from
     ventus_private.recurrence_instant(s.scheduled_date,s.start_time,s.timezone,rule.fold_side) then
    raise exception using errcode='22023', message='Selected start offset disagrees with recurrence';
  end if;
  if s.end_time is not null and s.ends_at is distinct from
     ventus_private.recurrence_instant(s.end_date,s.end_time,s.timezone,rule.fold_side) then
    raise exception using errcode='22023', message='Selected end offset disagrees with recurrence';
  end if;
  select * into c from public.categories where owner_id=actor and
    id=(p_task->>'category_id')::uuid and archived_at is null for share;
  if not found then raise exception using errcode='P0002', message='Category unavailable'; end if;
  fingerprint:=pg_catalog.sha256(pg_catalog.convert_to(
    pg_catalog.jsonb_build_array(p_task,p_rule)::text,'UTF8'));
  insert into public.tasks(owner_id,category_id,title,location,behavior_override,calendar_opt_in,
    creation_key,creation_fingerprint,recurrence_enabled)
  values(actor,c.id,pg_catalog.btrim(p_task->>'title'),p_task->>'location',
    p_task->>'behavior_override',coalesce((p_task->>'calendar_opt_in')::boolean,c.calendar_default),
    p_creation_key,fingerprint,true)
  on conflict (owner_id,creation_key) do nothing returning id into node_id;
  if node_id is null then
    select * into strict prior from public.tasks where owner_id=actor and creation_key=p_creation_key;
    if prior.creation_fingerprint is distinct from fingerprint or not prior.recurrence_enabled then
      raise exception using errcode='22023', message='Creation key was reused for different input';
    end if;
    if prior.deleted_at is not null then raise exception using errcode='P0002', message='Task unavailable'; end if;
    return pg_catalog.jsonb_build_object('task_id',prior.id,'created',false);
  end if;
  for child in select value from pg_catalog.jsonb_array_elements(coalesce(p_task->'subtasks','[]'::jsonb)) loop
    if child ? 'subtasks' and pg_catalog.jsonb_array_length(child->'subtasks')>0 then
      raise exception using errcode='22023', message='Recurring subtasks cannot nest';
    end if;
    if child->>'category_id' is distinct from c.id::text then
      raise exception using errcode='22023', message='Recurring subtasks inherit the parent category';
    end if;
    select * into strict child_slot from ventus_private.read_slot(child->'schedule');
    if child_slot.start_time is not null or child_slot.timezone<>s.timezone then
      raise exception using errcode='22023', message='Recurring subtasks must be anytime in the series zone';
    end if;
    insert into public.tasks(owner_id,category_id,parent_task_id,title,location,behavior_override,
      calendar_opt_in,recurrence_enabled)
    values(actor,c.id,node_id,pg_catalog.btrim(child->>'title'),child->>'location',
      child->>'behavior_override',false,true) returning id into child_id;
    templates:=templates || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'task_id',child_id,'day_offset',child_slot.scheduled_date-s.scheduled_date,
      'snapshot',ventus_private.snapshot(child_id)));
  end loop;
  insert into public.task_recurrence_revisions(owner_id,task_id,revision,effective_from,rule_end_date,
    anchor_date,frequency,weekdays,timezone,start_time,end_time,end_day_offset,fold_side,
    definition_snapshot,child_templates,actor_user_id)
  values(actor,node_id,1,s.scheduled_date,rule.end_date,s.scheduled_date,rule.frequency,
    rule.weekdays,s.timezone,s.start_time,s.end_time,
    coalesce(s.end_date-s.scheduled_date,0),rule.fold_side,
    ventus_private.snapshot(node_id),templates,actor);
  return pg_catalog.jsonb_build_object('task_id',node_id,'created',true);
end;
$$;

revoke all on function public.create_recurring_task(uuid,jsonb,jsonb) from public,anon,authenticated,service_role;
alter function public.create_recurring_task(uuid,jsonb,jsonb) owner to ventus_writer;
grant execute on function public.create_recurring_task(uuid,jsonb,jsonb) to authenticated;

create function public.convert_task_to_series(p_task_id uuid,p_expected_task_version bigint,
  p_expected_occurrence_version bigint,p_rule jsonb)
returns jsonb language plpgsql security definer set search_path = '' set row_security = on as $$
declare actor uuid:=ventus_private.request_user_id(); root_id uuid; first_row public.task_occurrences%rowtype;
  node public.tasks%rowtype; child record; rule record; begin_date date; templates jsonb:='[]'::jsonb;
begin
  if actor is null then raise exception using errcode='42501', message='Authentication required'; end if;
  select * into strict rule from ventus_private.read_recurrence_rule(p_rule);
  root_id:=ventus_private.lock_tree(p_task_id);
  if root_id<>p_task_id then raise exception using errcode='22023', message='Only a parent task can become a series'; end if;
  perform ventus_private.check_versions(p_task_id,p_expected_task_version,p_expected_occurrence_version);
  select * into strict first_row from public.task_occurrences
    where owner_id=actor and task_id=p_task_id and recurrence_key='once';
  select * into strict node from public.tasks where owner_id=actor and id=p_task_id;
  if first_row.status<>'open' then raise exception using errcode='22023', message='Reopen the task before enabling recurrence'; end if;
  begin_date:=greatest(first_row.scheduled_date+1,
    (pg_catalog.clock_timestamp() at time zone first_row.timezone)::date);
  if rule.end_date is not null and rule.end_date<begin_date then
    raise exception using errcode='22023', message='Recurrence must have a future date';
  end if;
  if first_row.start_time is not null and
     first_row.starts_at is distinct from ventus_private.recurrence_instant(
       first_row.scheduled_date,first_row.start_time,first_row.timezone,rule.fold_side) then
    raise exception using errcode='22023', message='Choose the recurrence fold side matching the first task';
  end if;
  for child in select t.*,o.scheduled_date,o.timezone,o.start_time,o.end_time,o.end_date,o.status
    from public.tasks t join public.task_occurrences o on o.owner_id=t.owner_id and o.task_id=t.id
    where t.owner_id=actor and t.parent_task_id=p_task_id and t.deleted_at is null
      and o.deleted_at is null and o.recurrence_key='once' loop
    if child.status<>'canceled' then
      if child.category_id<>node.category_id or child.timezone<>first_row.timezone then
        raise exception using errcode='22023', message='Active child category and zone must match the parent';
      end if;
      templates:=templates || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'task_id',child.id,'day_offset',child.scheduled_date-first_row.scheduled_date,
        'start_time',child.start_time,'end_time',child.end_time,
        'end_day_offset',coalesce(child.end_date-child.scheduled_date,0),
        'snapshot',ventus_private.snapshot(child.id)));
      update public.tasks set recurrence_enabled=true where owner_id=actor and id=child.id;
    end if;
  end loop;
  update public.tasks set recurrence_enabled=true where owner_id=actor and id=p_task_id;
  insert into public.task_recurrence_revisions(owner_id,task_id,revision,effective_from,rule_end_date,
    anchor_date,frequency,weekdays,timezone,start_time,end_time,end_day_offset,fold_side,
    definition_snapshot,child_templates,actor_user_id)
  values(actor,p_task_id,1,begin_date,rule.end_date,first_row.scheduled_date,rule.frequency,
    rule.weekdays,first_row.timezone,first_row.start_time,first_row.end_time,
    coalesce(first_row.end_date-first_row.scheduled_date,0),rule.fold_side,
    ventus_private.snapshot(p_task_id),templates,actor);
  return pg_catalog.jsonb_build_object('task_id',p_task_id,'task_version',
    (select version from public.tasks where owner_id=actor and id=p_task_id));
end;
$$;
revoke all on function public.convert_task_to_series(uuid,bigint,bigint,jsonb)
  from public,anon,authenticated,service_role;
alter function public.convert_task_to_series(uuid,bigint,bigint,jsonb) owner to ventus_writer;
grant execute on function public.convert_task_to_series(uuid,bigint,bigint,jsonb) to authenticated;

create function public.list_recurrence_candidates(p_from date,p_to date)
returns setof jsonb language plpgsql security definer set search_path = '' set row_security = on as $$
begin
  if ventus_private.request_user_id() is null then
    raise exception using errcode='42501', message='Authentication required';
  end if;
  if p_from is null or p_to is null or p_to<p_from or p_to-p_from>6 then
    raise exception using errcode='22023', message='A bounded seven-day window is required';
  end if;
  return query
  with revisions as (
    select r.* from public.task_recurrence_revisions r
      join public.tasks t on t.owner_id=r.owner_id and t.id=r.task_id
    where r.owner_id=ventus_private.request_user_id() and t.deleted_at is null and not r.stopped
  ), candidate as (
    select r.owner_id,r.task_id,r.task_id as node_id,null::uuid as parent_id,
      d.day::date as key_day,d.day::date as slot_day,r.timezone,r.start_time,r.end_time,
      r.end_day_offset,r.fold_side,r.definition_snapshot as snapshot
    from revisions r cross join lateral pg_catalog.generate_series(
      greatest(p_from,r.effective_from),
      least(p_to,coalesce(r.effective_until-1,p_to),coalesce(r.rule_end_date,p_to)),
      interval '1 day') d(day)
    where ventus_private.recurrence_matches(r.frequency,r.anchor_date,d.day::date,r.weekdays)
    union all
    select r.owner_id,r.task_id,(child.value->>'task_id')::uuid,r.task_id,
      d.day::date,(d.day::date+(child.value->>'day_offset')::integer),
      r.timezone,(child.value->>'start_time')::time,(child.value->>'end_time')::time,
      coalesce((child.value->>'end_day_offset')::integer,0),r.fold_side,
      child.value->'snapshot'
    from revisions r cross join lateral pg_catalog.jsonb_array_elements(r.child_templates) child(value)
      cross join lateral pg_catalog.generate_series(
        greatest(p_from-(child.value->>'day_offset')::integer,r.effective_from),
        least(p_to-(child.value->>'day_offset')::integer,
          coalesce(r.effective_until-1,p_to-(child.value->>'day_offset')::integer),
          coalesce(r.rule_end_date,p_to-(child.value->>'day_offset')::integer)),
        interval '1 day') d(day)
    where ventus_private.recurrence_matches(r.frequency,r.anchor_date,d.day::date,r.weekdays)
      and not exists(select 1 from public.task_occurrences parent_occurrence
        where parent_occurrence.owner_id=r.owner_id and parent_occurrence.task_id=r.task_id
          and parent_occurrence.recurrence_key=d.day::date::text
          and parent_occurrence.deleted_at is not null)
      and not exists(select 1 from public.task_recurrence_revisions stop
        where stop.owner_id=r.owner_id and stop.task_id=r.task_id and stop.stopped
          and stop.effective_from<=d.day::date+(child.value->>'day_offset')::integer)
  ), instants as (
    select c.*,
      case when c.start_time is null then null else
        ventus_private.recurrence_instant(c.slot_day,c.start_time,c.timezone,c.fold_side) end as starts_at,
      case when c.end_time is null then null else
        ventus_private.recurrence_instant(c.slot_day+c.end_day_offset,c.end_time,c.timezone,c.fold_side) end as ends_at
    from candidate c
  )
  select pg_catalog.jsonb_build_object(
    'task_id',i.node_id,'parent_task_id',i.parent_id,'recurrence_key',i.key_day::text,
    'scheduled_date',i.slot_day,'timezone',i.timezone,'start_time',i.start_time,
    'starts_at',i.starts_at,'end_date',case when i.end_time is null then null else i.slot_day+i.end_day_offset end,
    'end_time',i.end_time,'ends_at',i.ends_at,'definition_snapshot',i.snapshot)
  from instants i where (i.start_time is null or i.starts_at is not null)
    and (i.end_time is null or (i.ends_at is not null and i.ends_at>i.starts_at));
end;
$$;
revoke all on function public.list_recurrence_candidates(date,date)
  from public,anon,authenticated,service_role;
alter function public.list_recurrence_candidates(date,date) owner to ventus_writer;
grant execute on function public.list_recurrence_candidates(date,date) to authenticated;

create function public.mutate_recurring_occurrence(p_task_id uuid,p_recurrence_key text,
  p_expected_series_version bigint,p_expected_occurrence_version bigint,p_action text,
  p_schedule jsonb default null,p_patch jsonb default null,p_reason text default null)
returns jsonb language plpgsql security definer set search_path = '' set row_security = on as $$
declare actor uuid:=ventus_private.request_user_id(); root_id uuid; t public.tasks%rowtype;
  o public.task_occurrences%rowtype; r public.task_recurrence_revisions%rowtype;
  template jsonb; key_day date; slot_day date; local_start time; local_end time;
  end_offset integer; starts timestamptz; ends timestamptz; snapshot jsonb;
  before_doc jsonb; s record; category public.categories%rowtype; event_name text;
begin
  if actor is null then raise exception using errcode='42501', message='Authentication required'; end if;
  if p_recurrence_key is null or (p_recurrence_key<>'once' and
     p_recurrence_key !~ '^\d{4}-\d{2}-\d{2}$') or
     p_action not in ('complete','reopen','postpone','cancel','delete','edit') or
     pg_catalog.octet_length(coalesce(p_patch::text,''))>4096 or
     pg_catalog.octet_length(coalesce(p_schedule::text,''))>4096 or
     char_length(p_reason)>500 then
    raise exception using errcode='22023', message='Invalid occurrence command';
  end if;
  root_id:=ventus_private.lock_tree(p_task_id);
  select * into strict t from public.tasks where owner_id=actor and id=p_task_id and deleted_at is null;
  if not t.recurrence_enabled then raise exception using errcode='0A000', message='Use one-time task operation'; end if;
  if t.parent_task_id is not null and exists(select 1 from public.task_occurrences parent_occurrence
    where parent_occurrence.owner_id=actor and parent_occurrence.task_id=t.parent_task_id
      and parent_occurrence.recurrence_key=p_recurrence_key
      and parent_occurrence.deleted_at is not null) then
    raise exception using errcode='P0002', message='Parent occurrence was deleted';
  end if;
  if p_expected_series_version is null or not exists(
    select 1 from public.tasks where owner_id=actor and id=root_id and version=p_expected_series_version) then
    raise exception using errcode='40001', message='Series changed; refetch';
  end if;
  if p_recurrence_key='once' then
    select * into o from public.task_occurrences where owner_id=actor and task_id=p_task_id
      and recurrence_key='once' for update;
    if not found then raise exception using errcode='P0002', message='Occurrence unavailable'; end if;
  else
    key_day:=p_recurrence_key::date;
    select * into o from public.task_occurrences where owner_id=actor and task_id=p_task_id
      and recurrence_key=p_recurrence_key for update;
    select * into r from ventus_private.recurrence_revision(root_id,key_day);
    if r.id is null and o.id is null then raise exception using errcode='P0002', message='Occurrence unavailable'; end if;
    if exists(select 1 from public.task_recurrence_revisions stop
      where stop.owner_id=actor and stop.task_id=root_id and stop.stopped and
        (stop.effective_from<=key_day or stop.effective_from<=o.scheduled_date)) then
      raise exception using errcode='P0002', message='Occurrence unavailable';
    end if;
    if r.id is not null and o.id is null then
      if p_task_id=root_id then
        template:=null;
        slot_day:=key_day; local_start:=r.start_time; local_end:=r.end_time;
        end_offset:=r.end_day_offset; snapshot:=r.definition_snapshot;
      else
        select value into template from pg_catalog.jsonb_array_elements(r.child_templates)
          where value->>'task_id'=p_task_id::text;
        if template is null or t.parent_task_id<>root_id then
          raise exception using errcode='P0002', message='Occurrence unavailable';
        end if;
        slot_day:=key_day+(template->>'day_offset')::integer;
        local_start:=(template->>'start_time')::time;
        local_end:=(template->>'end_time')::time;
        end_offset:=coalesce((template->>'end_day_offset')::integer,0);
        snapshot:=template->'snapshot';
      end if;
      starts:=case when local_start is null then null else
        ventus_private.recurrence_instant(slot_day,local_start,r.timezone,r.fold_side) end;
      ends:=case when local_end is null then null else
        ventus_private.recurrence_instant(slot_day+end_offset,local_end,r.timezone,r.fold_side) end;
      if (local_start is not null and starts is null) or
         (local_end is not null and (ends is null or ends<=starts)) then
        raise exception using errcode='P0002', message='Occurrence skipped at daylight saving transition';
      end if;
      if p_expected_occurrence_version<>0 then raise exception using errcode='40001', message='Occurrence changed'; end if;
      insert into public.task_occurrences(owner_id,task_id,recurrence_key,scheduled_date,timezone,
        start_time,starts_at,end_date,end_time,ends_at,definition_snapshot)
      values(actor,p_task_id,p_recurrence_key,slot_day,r.timezone,local_start,starts,
        case when local_end is null then null else slot_day+end_offset end,local_end,ends,snapshot)
      on conflict (task_id,recurrence_key) do nothing;
      select * into strict o from public.task_occurrences where owner_id=actor and task_id=p_task_id
        and recurrence_key=p_recurrence_key for update;
      if o.version<>1 or o.is_exception then raise exception using errcode='40001', message='Occurrence changed'; end if;
    end if;
  end if;
  if o.deleted_at is not null or
     (p_expected_occurrence_version<>0 and o.version<>p_expected_occurrence_version) or
     (p_expected_occurrence_version=0 and o.version<>1) then
    raise exception using errcode='40001', message='Occurrence changed';
  end if;
  before_doc:=pg_catalog.jsonb_build_object('task',pg_catalog.to_jsonb(t)
    - 'creation_key' - 'creation_fingerprint','occurrence',pg_catalog.to_jsonb(o));
  if p_action='complete' then
    if o.status='canceled' then raise exception using errcode='22023', message='Canceled occurrence cannot complete'; end if;
    if o.status='completed' then return pg_catalog.jsonb_build_object('occurrence_id',o.id,'version',o.version); end if;
    update public.task_occurrences set status='completed',completed_at=pg_catalog.clock_timestamp(),
      is_exception=true where id=o.id;
    event_name:='completed';
  elsif p_action='reopen' then
    if o.status<>'completed' then raise exception using errcode='22023', message='Only completed occurrence can reopen'; end if;
    update public.task_occurrences set status='open',completed_at=null,is_exception=true where id=o.id;
    event_name:='reopened';
  elsif p_action='cancel' then
    if o.status<>'open' then raise exception using errcode='22023', message='Only open occurrence can cancel'; end if;
    update public.task_occurrences set status='canceled',cancellation_reason=p_reason,
      is_exception=true where id=o.id;
    event_name:='canceled';
  elsif p_action='delete' then
    update public.task_occurrences set deleted_at=pg_catalog.clock_timestamp(),is_exception=true where id=o.id;
    event_name:='deleted';
  else
    if o.status<>'open' then raise exception using errcode='22023', message='Reopen before editing'; end if;
    if p_action='postpone' and p_schedule is null then
      raise exception using errcode='22023', message='A new schedule is required';
    end if;
    if p_action='edit' then
      perform ventus_private.assert_keys(p_patch,array['title','location','category_id'],array[]::text[]);
      if p_patch ? 'title' and
         (pg_catalog.jsonb_typeof(p_patch->'title')<>'string' or
          char_length(pg_catalog.btrim(p_patch->>'title')) not between 1 and 240) then
        raise exception using errcode='22023', message='Invalid occurrence title';
      end if;
      if p_patch ? 'location' and char_length(p_patch->>'location')>1000 then
        raise exception using errcode='22023', message='Invalid occurrence location';
      end if;
      if p_patch ? 'category_id' then
        if t.parent_task_id is not null then raise exception using errcode='22023', message='Child category is inherited'; end if;
        if exists(select 1 from public.tasks child
             where child.owner_id=actor and child.parent_task_id=p_task_id and child.deleted_at is null) then
          raise exception using errcode='22023', message='Change the series category when it has recurring subtasks';
        end if;
        select * into category from public.categories where owner_id=actor and
          id=(p_patch->>'category_id')::uuid and archived_at is null for share;
        if not found then raise exception using errcode='P0002', message='Category unavailable'; end if;
        snapshot:=pg_catalog.jsonb_set(o.definition_snapshot,'{category_id}',pg_catalog.to_jsonb(category.id::text));
        snapshot:=pg_catalog.jsonb_set(snapshot,'{category_name}',pg_catalog.to_jsonb(category.name));
        snapshot:=pg_catalog.jsonb_set(snapshot,'{behavior}',
          pg_catalog.to_jsonb(coalesce(t.behavior_override,category.behavior)));
      else snapshot:=o.definition_snapshot; end if;
      if p_patch ? 'title' then snapshot:=pg_catalog.jsonb_set(snapshot,'{title}',
        pg_catalog.to_jsonb(pg_catalog.btrim(p_patch->>'title'))); end if;
      if p_patch ? 'location' then snapshot:=pg_catalog.jsonb_set(snapshot,'{location}',
        p_patch->'location'); end if;
    else snapshot:=o.definition_snapshot; end if;
    if p_schedule is not null then
      select * into strict s from ventus_private.read_slot(p_schedule);
      if s.timezone<>o.timezone then
        raise exception using errcode='22023', message='Occurrence timezone cannot change';
      end if;
      update public.task_occurrences set scheduled_date=s.scheduled_date,timezone=s.timezone,
        start_time=s.start_time,starts_at=s.starts_at,end_date=s.end_date,end_time=s.end_time,
        ends_at=s.ends_at,definition_snapshot=snapshot,is_exception=true where id=o.id;
    else
      update public.task_occurrences set definition_snapshot=snapshot,is_exception=true where id=o.id;
    end if;
    event_name:=case when p_action='postpone' then 'postponed' else 'edited' end;
  end if;
  insert into public.task_activity(owner_id,task_id,occurrence_id,occurrence_version,actor_user_id,
    action,effective_at,before_state,after_state)
  select actor,p_task_id,o.id,updated.version,actor,event_name,
    case when event_name='completed' then updated.completed_at else pg_catalog.clock_timestamp() end,
    before_doc,pg_catalog.jsonb_build_object('task',pg_catalog.to_jsonb(t)
      - 'creation_key' - 'creation_fingerprint','occurrence',pg_catalog.to_jsonb(updated))
  from public.task_occurrences updated where updated.id=o.id;
  return pg_catalog.jsonb_build_object('occurrence_id',o.id,'version',
    (select version from public.task_occurrences where id=o.id));
end;
$$;
revoke all on function public.mutate_recurring_occurrence(uuid,text,bigint,bigint,text,jsonb,jsonb,text)
  from public,anon,authenticated,service_role;
alter function public.mutate_recurring_occurrence(uuid,text,bigint,bigint,text,jsonb,jsonb,text) owner to ventus_writer;
grant execute on function public.mutate_recurring_occurrence(uuid,text,bigint,bigint,text,jsonb,jsonb,text)
  to authenticated;

create function public.change_recurring_series(p_task_id uuid,p_expected_series_version bigint,
  p_from_date date,p_stop boolean,p_rule jsonb default null,p_schedule jsonb default null,
  p_title text default null,p_category_id uuid default null,p_location text default null)
returns jsonb language plpgsql security definer set search_path = '' set row_security = on as $$
declare actor uuid:=ventus_private.request_user_id(); root_id uuid; old_rule public.task_recurrence_revisions%rowtype;
  rule record; slot record; chosen public.categories%rowtype; node public.tasks%rowtype;
  templates jsonb; next_revision integer; current_day date;
begin
  if actor is null then raise exception using errcode='42501', message='Authentication required'; end if;
  root_id:=ventus_private.lock_tree(p_task_id);
  if root_id<>p_task_id then raise exception using errcode='22023', message='Series changes require the parent task'; end if;
  select * into strict node from public.tasks where owner_id=actor and id=p_task_id;
  if not node.recurrence_enabled then raise exception using errcode='0A000', message='Task is not recurring'; end if;
  if node.version<>p_expected_series_version then raise exception using errcode='40001', message='Series changed; refetch'; end if;
  select * into old_rule from public.task_recurrence_revisions
    where owner_id=actor and task_id=p_task_id and effective_from<=p_from_date
      and (effective_until is null or p_from_date<effective_until)
    order by revision desc limit 1;
  if old_rule.id is null or old_rule.stopped then raise exception using errcode='P0002', message='Series unavailable'; end if;
  if exists(select 1 from public.task_recurrence_revisions stop where stop.owner_id=actor
    and stop.task_id=p_task_id and stop.stopped) then
    raise exception using errcode='P0002', message='Stopped series cannot be changed';
  end if;
  current_day:=(pg_catalog.clock_timestamp() at time zone old_rule.timezone)::date;
  if p_from_date<current_day then raise exception using errcode='22023', message='Series changes start today or later'; end if;
  if p_stop is null then raise exception using errcode='22023', message='Choose edit or stop'; end if;
  if not p_stop then
    if p_rule is null or p_schedule is null or p_title is null or p_category_id is null or
       char_length(pg_catalog.btrim(p_title)) not between 1 and 240 or char_length(p_location)>1000 then
      raise exception using errcode='22023', message='A complete series template is required';
    end if;
    select * into strict rule from ventus_private.read_recurrence_rule(p_rule);
    select * into strict slot from ventus_private.read_slot(p_schedule);
    if slot.scheduled_date<p_from_date or slot.timezone<>old_rule.timezone or
       (rule.end_date is not null and rule.end_date<slot.scheduled_date) or
       not ventus_private.recurrence_matches(rule.frequency,slot.scheduled_date,slot.scheduled_date,rule.weekdays) or
       coalesce(slot.end_date-slot.scheduled_date,0)>7 then
      raise exception using errcode='22023', message='Invalid series start or zone';
    end if;
    if (slot.start_time is not null and slot.starts_at is distinct from
        ventus_private.recurrence_instant(slot.scheduled_date,slot.start_time,slot.timezone,rule.fold_side))
       or (slot.end_time is not null and slot.ends_at is distinct from
        ventus_private.recurrence_instant(slot.end_date,slot.end_time,slot.timezone,rule.fold_side)) then
      raise exception using errcode='22023', message='Selected offset disagrees with recurrence';
    end if;
    select * into chosen from public.categories where owner_id=actor and id=p_category_id
      and archived_at is null for share;
    if not found then raise exception using errcode='P0002', message='Category unavailable'; end if;
  end if;
  select coalesce(max(revision),0)+1 into next_revision from public.task_recurrence_revisions
    where owner_id=actor and task_id=p_task_id;
  -- Preserve every revision row. Superseded future rows become empty date ranges.
  update public.task_recurrence_revisions set effective_until=effective_from
    where owner_id=actor and task_id=p_task_id and effective_from>=p_from_date
      and (effective_until is null or effective_until>effective_from);
  update public.task_recurrence_revisions set effective_until=p_from_date
    where owner_id=actor and task_id=p_task_id and effective_from<p_from_date
      and (effective_until is null or effective_until>p_from_date);
  if p_stop then
    update public.tasks set updated_at=pg_catalog.clock_timestamp() where owner_id=actor and id=p_task_id;
    insert into public.task_recurrence_revisions(owner_id,task_id,revision,effective_from,anchor_date,
      frequency,weekdays,timezone,start_time,end_time,end_day_offset,fold_side,
      definition_snapshot,child_templates,stopped,actor_user_id)
    values(actor,p_task_id,next_revision,p_from_date,p_from_date,old_rule.frequency,old_rule.weekdays,
      old_rule.timezone,old_rule.start_time,old_rule.end_time,old_rule.end_day_offset,
      old_rule.fold_side,old_rule.definition_snapshot,old_rule.child_templates,true,actor);
  else
    update public.tasks set title=pg_catalog.btrim(p_title),category_id=p_category_id,
      location=p_location,updated_at=pg_catalog.clock_timestamp()
      where owner_id=actor and id=p_task_id;
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_set(
      pg_catalog.jsonb_set(pg_catalog.jsonb_set(value,'{snapshot,category_id}',
        pg_catalog.to_jsonb(chosen.id::text)),'{snapshot,category_name}',
        pg_catalog.to_jsonb(chosen.name)),'{snapshot,behavior}',
        pg_catalog.to_jsonb(coalesce(child_task.behavior_override,chosen.behavior)))),'[]'::jsonb)
      into templates
      from pg_catalog.jsonb_array_elements(old_rule.child_templates) child_template(value)
      join public.tasks child_task on child_task.owner_id=actor
        and child_task.id=(value->>'task_id')::uuid;
    insert into public.task_recurrence_revisions(owner_id,task_id,revision,effective_from,rule_end_date,
      anchor_date,frequency,weekdays,timezone,start_time,end_time,end_day_offset,fold_side,
      definition_snapshot,child_templates,actor_user_id)
    values(actor,p_task_id,next_revision,p_from_date,rule.end_date,slot.scheduled_date,rule.frequency,
      rule.weekdays,slot.timezone,slot.start_time,slot.end_time,
      coalesce(slot.end_date-slot.scheduled_date,0),rule.fold_side,
      ventus_private.snapshot(p_task_id),templates,actor);
  end if;
  return pg_catalog.jsonb_build_object('task_id',p_task_id,'series_version',
    (select version from public.tasks where owner_id=actor and id=p_task_id));
end;
$$;
revoke all on function public.change_recurring_series(uuid,bigint,date,boolean,jsonb,jsonb,text,uuid,text)
  from public,anon,authenticated,service_role;
alter function public.change_recurring_series(uuid,bigint,date,boolean,jsonb,jsonb,text,uuid,text)
  owner to ventus_writer;
grant execute on function public.change_recurring_series(uuid,bigint,date,boolean,jsonb,jsonb,text,uuid,text)
  to authenticated;

create function public.change_recurring_child_series(p_task_id uuid,p_expected_series_version bigint,
  p_from_date date,p_title text,p_location text,p_schedule jsonb)
returns jsonb language plpgsql security definer set search_path = '' set row_security = on as $$
declare actor uuid:=ventus_private.request_user_id(); root_id uuid; child public.tasks%rowtype;
  old_rule public.task_recurrence_revisions%rowtype; slot record; old_template jsonb;
  templates jsonb; revised jsonb; next_revision integer;
begin
  if actor is null then raise exception using errcode='42501', message='Authentication required'; end if;
  root_id:=ventus_private.lock_tree(p_task_id);
  if root_id=p_task_id or p_from_date is null or p_title is null or p_schedule is null or
     char_length(pg_catalog.btrim(p_title)) not between 1 and 240 or char_length(p_location)>1000 then
    raise exception using errcode='22023', message='Invalid recurring subtask change';
  end if;
  select * into strict child from public.tasks where owner_id=actor and id=p_task_id
    and parent_task_id=root_id and recurrence_enabled and deleted_at is null;
  if not exists(select 1 from public.tasks where owner_id=actor and id=root_id
    and version=p_expected_series_version and deleted_at is null) then
    raise exception using errcode='40001', message='Series changed; refetch';
  end if;
  if exists(select 1 from public.task_recurrence_revisions stop where stop.owner_id=actor
    and stop.task_id=root_id and stop.stopped) then
    raise exception using errcode='P0002', message='Stopped series cannot be changed';
  end if;
  select * into old_rule from ventus_private.recurrence_revision(root_id,p_from_date);
  if old_rule.id is null then raise exception using errcode='P0002', message='Series unavailable'; end if;
  if p_from_date<(pg_catalog.clock_timestamp() at time zone old_rule.timezone)::date then
    raise exception using errcode='22023', message='Series changes start today or later';
  end if;
  select value into old_template from pg_catalog.jsonb_array_elements(old_rule.child_templates)
    where value->>'task_id'=p_task_id::text;
  if old_template is null then raise exception using errcode='P0002', message='Subtask template unavailable'; end if;
  select * into strict slot from ventus_private.read_slot(p_schedule);
  if slot.timezone<>old_rule.timezone or
     coalesce(slot.end_date-slot.scheduled_date,0)>7 or
     (slot.start_time is not null and slot.starts_at is distinct from
       ventus_private.recurrence_instant(slot.scheduled_date,slot.start_time,slot.timezone,old_rule.fold_side)) or
     (slot.end_time is not null and slot.ends_at is distinct from
       ventus_private.recurrence_instant(slot.end_date,slot.end_time,slot.timezone,old_rule.fold_side)) then
    raise exception using errcode='22023', message='Invalid subtask schedule or fold side';
  end if;
  revised:=old_template || pg_catalog.jsonb_build_object(
    'day_offset',slot.scheduled_date-p_from_date,'start_time',slot.start_time,
    'end_time',slot.end_time,'end_day_offset',coalesce(slot.end_date-slot.scheduled_date,0),
    'snapshot',pg_catalog.jsonb_set(pg_catalog.jsonb_set(old_template->'snapshot',
      '{title}',pg_catalog.to_jsonb(pg_catalog.btrim(p_title))),'{location}',
      coalesce(pg_catalog.to_jsonb(p_location),'null'::jsonb)));
  select coalesce(pg_catalog.jsonb_agg(case when value->>'task_id'=p_task_id::text
    then revised else value end),'[]'::jsonb) into templates
    from pg_catalog.jsonb_array_elements(old_rule.child_templates);
  select coalesce(max(revision),0)+1 into next_revision from public.task_recurrence_revisions
    where owner_id=actor and task_id=root_id;
  update public.task_recurrence_revisions set effective_until=effective_from
    where owner_id=actor and task_id=root_id and effective_from>=p_from_date
      and (effective_until is null or effective_until>effective_from);
  update public.task_recurrence_revisions set effective_until=p_from_date
    where owner_id=actor and task_id=root_id and effective_from<p_from_date
      and (effective_until is null or effective_until>p_from_date);
  update public.tasks set title=pg_catalog.btrim(p_title),location=p_location
    where owner_id=actor and id=p_task_id;
  update public.tasks set updated_at=pg_catalog.clock_timestamp()
    where owner_id=actor and id=root_id;
  insert into public.task_recurrence_revisions(owner_id,task_id,revision,effective_from,
    rule_end_date,anchor_date,frequency,weekdays,timezone,start_time,end_time,end_day_offset,
    fold_side,definition_snapshot,child_templates,actor_user_id)
  values(actor,root_id,next_revision,p_from_date,old_rule.rule_end_date,old_rule.anchor_date,
    old_rule.frequency,old_rule.weekdays,old_rule.timezone,old_rule.start_time,
    old_rule.end_time,old_rule.end_day_offset,old_rule.fold_side,
    old_rule.definition_snapshot,templates,actor);
  return pg_catalog.jsonb_build_object('task_id',p_task_id,'series_version',
    (select version from public.tasks where owner_id=actor and id=root_id));
end;
$$;
revoke all on function public.change_recurring_child_series(uuid,bigint,date,text,text,jsonb)
  from public,anon,authenticated,service_role;
alter function public.change_recurring_child_series(uuid,bigint,date,text,text,jsonb)
  owner to ventus_writer;
grant execute on function public.change_recurring_child_series(uuid,bigint,date,text,text,jsonb)
  to authenticated;

create function public.read_recurrence_context(p_task_id uuid,p_key text)
returns jsonb language plpgsql security definer set search_path = '' set row_security = on as $$
declare actor uuid:=ventus_private.request_user_id(); root_id uuid; root_version bigint;
  r public.task_recurrence_revisions%rowtype; item jsonb; candidate jsonb; stored public.task_occurrences%rowtype;
  node_id uuid; slot_day date; nodes jsonb:='[]'::jsonb; target_found boolean:=false;
begin
  if actor is null then raise exception using errcode='42501', message='Authentication required'; end if;
  if p_key is null or (p_key<>'once' and p_key !~ '^\d{4}-\d{2}-\d{2}$') then
    raise exception using errcode='22023', message='Invalid occurrence key';
  end if;
  root_id:=ventus_private.tree_root(p_task_id);
  if p_task_id<>root_id and exists(select 1 from public.task_occurrences parent_occurrence
    where parent_occurrence.owner_id=actor and parent_occurrence.task_id=root_id
      and parent_occurrence.recurrence_key=p_key
      and parent_occurrence.deleted_at is not null) then
    raise exception using errcode='P0002', message='Parent occurrence was deleted';
  end if;
  select version into root_version from public.tasks where owner_id=actor and id=root_id
    and recurrence_enabled and deleted_at is null;
  if not found then raise exception using errcode='P0002', message='Series unavailable'; end if;
  if p_key<>'once' then
    select * into r from ventus_private.recurrence_revision(root_id,p_key::date);
  else
    select * into r from public.task_recurrence_revisions where owner_id=actor and task_id=root_id
      order by revision limit 1;
  end if;
  for item in
    select pg_catalog.jsonb_build_object('task_id',root_id,'day_offset',0)
    union all
    select value from pg_catalog.jsonb_array_elements(coalesce(r.child_templates,'[]'::jsonb))
  loop
    node_id:=(item->>'task_id')::uuid;
    if p_key='once' then
      select * into stored from public.task_occurrences where owner_id=actor and task_id=node_id
        and recurrence_key='once' and deleted_at is null;
      if found then
        nodes:=nodes || pg_catalog.jsonb_build_array(pg_catalog.to_jsonb(stored));
        if node_id=p_task_id then target_found:=true; end if;
      end if;
    else
      slot_day:=p_key::date+coalesce((item->>'day_offset')::integer,0);
      select c.value into candidate from public.list_recurrence_candidates(slot_day,slot_day) c(value)
        where c.value->>'task_id'=node_id::text and c.value->>'recurrence_key'=p_key limit 1;
      select * into stored from public.task_occurrences where owner_id=actor and task_id=node_id
        and recurrence_key=p_key and deleted_at is null;
      if found then
        nodes:=nodes || pg_catalog.jsonb_build_array(pg_catalog.to_jsonb(stored));
        if node_id=p_task_id then target_found:=true; end if;
      elsif candidate is not null then
        nodes:=nodes || pg_catalog.jsonb_build_array(candidate);
        if node_id=p_task_id then target_found:=true; end if;
      end if;
    end if;
  end loop;
  if not target_found and p_key<>'once' and not exists(
    select 1 from public.task_recurrence_revisions stop where stop.owner_id=actor
      and stop.task_id=root_id and stop.stopped and stop.effective_from<=p_key::date) then
    select * into stored from public.task_occurrences where owner_id=actor and task_id=p_task_id
      and recurrence_key=p_key and deleted_at is null;
    if found then
      nodes:=nodes || pg_catalog.jsonb_build_array(pg_catalog.to_jsonb(stored));
      target_found:=true;
    end if;
  end if;
  if not target_found then raise exception using errcode='P0002', message='Occurrence unavailable'; end if;
  return pg_catalog.jsonb_build_object('root_id',root_id,'root_version',root_version,
    'nodes',nodes,'rule',case when r.id is null then null else pg_catalog.jsonb_build_object(
      'frequency',r.frequency,'weekdays',r.weekdays,'end_date',r.rule_end_date,
      'fold_side',r.fold_side,'effective_from',r.effective_from) end);
end;
$$;
revoke all on function public.read_recurrence_context(uuid,text)
  from public,anon,authenticated,service_role;
alter function public.read_recurrence_context(uuid,text) owner to ventus_writer;
grant execute on function public.read_recurrence_context(uuid,text) to authenticated;

revoke create on schema public from ventus_writer;
revoke all on all functions in schema ventus_private from public,anon,authenticated,service_role;
grant execute on all functions in schema ventus_private to ventus_writer;

commit;
