begin;

-- Ownership transfer needs CREATE on the destination schema; the temporary
-- grant is revoked in this same transaction and is never externally visible.
grant create on schema ventus_private to ventus_writer;
grant create on schema public to ventus_writer;

-- Move a child's current local slot by the parent's date change. Keep its own
-- wall time, timezone, duration and chosen DST fold when that choice is known.
create function ventus_private.shift_occurrence_slot(p_slot jsonb, p_days integer, p_default_side text)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare old_day date:=(p_slot->>'scheduled_date')::date; new_day date;
  old_end date:=(p_slot->>'end_date')::date; new_end date;
  zone text:=p_slot->>'timezone'; local_start time:=(p_slot->>'start_time')::time;
  local_end time:=(p_slot->>'end_time')::time; start_side text:=p_default_side;
  end_side text:=p_default_side; starts timestamptz; ends timestamptz;
begin
  new_day:=old_day+p_days;
  new_end:=case when old_end is null then null else old_end+p_days end;
  if local_start is not null then
    if (p_slot->>'starts_at')::timestamptz =
       ventus_private.recurrence_instant(old_day,local_start,zone,'later') and
       ventus_private.recurrence_instant(old_day,local_start,zone,'later') is distinct from
       ventus_private.recurrence_instant(old_day,local_start,zone,'earlier') then
      start_side:='later';
    elsif (p_slot->>'starts_at')::timestamptz =
       ventus_private.recurrence_instant(old_day,local_start,zone,'earlier') and
       ventus_private.recurrence_instant(old_day,local_start,zone,'later') is distinct from
       ventus_private.recurrence_instant(old_day,local_start,zone,'earlier') then
      start_side:='earlier';
    end if;
    starts:=ventus_private.recurrence_instant(new_day,local_start,zone,start_side);
  end if;
  if local_end is not null then
    if (p_slot->>'ends_at')::timestamptz =
       ventus_private.recurrence_instant(old_end,local_end,zone,'later') and
       ventus_private.recurrence_instant(old_end,local_end,zone,'later') is distinct from
       ventus_private.recurrence_instant(old_end,local_end,zone,'earlier') then
      end_side:='later';
    elsif (p_slot->>'ends_at')::timestamptz =
       ventus_private.recurrence_instant(old_end,local_end,zone,'earlier') and
       ventus_private.recurrence_instant(old_end,local_end,zone,'later') is distinct from
       ventus_private.recurrence_instant(old_end,local_end,zone,'earlier') then
      end_side:='earlier';
    end if;
    ends:=ventus_private.recurrence_instant(new_end,local_end,zone,end_side);
  end if;
  perform ventus_private.validate_slot(new_day,zone,local_start,new_end,local_end,starts,ends);
  return pg_catalog.jsonb_build_object('date',new_day,'timezone',zone,'start_time',local_start,
    'end_date',new_end,'end_time',local_end,'starts_at',starts,'ends_at',ends);
end;
$$;
revoke all on function ventus_private.shift_occurrence_slot(jsonb,integer,text)
  from public,anon,authenticated,service_role;
grant execute on function ventus_private.shift_occurrence_slot(jsonb,integer,text) to ventus_writer;

-- Preserve the reviewed single-occurrence implementations as private building
-- blocks. The public RPC signatures stay unchanged, so direct callers cannot
-- bypass the atomic parent-and-children operation.
alter function public.postpone_task(uuid,bigint,bigint,jsonb) set schema ventus_private;
alter function ventus_private.postpone_task(uuid,bigint,bigint,jsonb) rename to postpone_one;
revoke all on function ventus_private.postpone_one(uuid,bigint,bigint,jsonb)
  from public,anon,authenticated,service_role;

create function public.postpone_task(p_task_id uuid,p_expected_task_version bigint,
  p_expected_occurrence_version bigint,p_schedule jsonb) returns jsonb
language plpgsql security definer set search_path = '' set row_security = on as $$
declare root_id uuid; old_day date; new_day date; days_to_move integer; child record;
begin
  if ventus_private.request_user_id() is null then
    raise exception using errcode='42501', message='Authentication required';
  end if;
  if p_schedule is null or pg_catalog.octet_length(p_schedule::text)>4096 then
    raise exception using errcode='22023', message='A bounded schedule is required';
  end if;
  root_id:=ventus_private.lock_tree(p_task_id);
  perform ventus_private.check_versions(p_task_id,p_expected_task_version,p_expected_occurrence_version);
  select scheduled_date into strict old_day from public.task_occurrences
    where owner_id=ventus_private.request_user_id() and task_id=p_task_id and recurrence_key='once';
  select scheduled_date into strict new_day from ventus_private.read_slot(p_schedule);
  days_to_move:=new_day-old_day;
  perform ventus_private.postpone_one(p_task_id,p_expected_task_version,p_expected_occurrence_version,p_schedule);
  if days_to_move<>0 then
    for child in
      with recursive descendants as (
        select t.id,t.parent_task_id,1 as depth from public.tasks t
          where t.owner_id=ventus_private.request_user_id() and t.parent_task_id=p_task_id
        union all
        select t.id,t.parent_task_id,d.depth+1 from public.tasks t
          join descendants d on t.parent_task_id=d.id
          where t.owner_id=ventus_private.request_user_id() and d.depth<100
      )
      select t.id,t.version as task_version,o.version as occurrence_version,
        pg_catalog.to_jsonb(o) as slot from descendants d
        join public.tasks t on t.owner_id=ventus_private.request_user_id() and t.id=d.id
        join public.task_occurrences o on o.owner_id=t.owner_id and o.task_id=t.id
      where t.deleted_at is null and o.deleted_at is null and o.status='open'
        and o.recurrence_key='once'
      order by d.depth,t.id
    loop
      perform ventus_private.postpone_one(child.id,child.task_version,child.occurrence_version,
        ventus_private.shift_occurrence_slot(child.slot,days_to_move,'earlier'));
    end loop;
  end if;
  return ventus_private.task_result(p_task_id,root_id);
end;
$$;
revoke all on function public.postpone_task(uuid,bigint,bigint,jsonb)
  from public,anon,authenticated,service_role;
alter function public.postpone_task(uuid,bigint,bigint,jsonb) owner to ventus_writer;
grant execute on function public.postpone_task(uuid,bigint,bigint,jsonb) to authenticated;

alter function public.mutate_recurring_occurrence(uuid,text,bigint,bigint,text,jsonb,jsonb,text)
  set schema ventus_private;
alter function ventus_private.mutate_recurring_occurrence(uuid,text,bigint,bigint,text,jsonb,jsonb,text)
  rename to mutate_one;
revoke all on function ventus_private.mutate_one(uuid,text,bigint,bigint,text,jsonb,jsonb,text)
  from public,anon,authenticated,service_role;

create function public.mutate_recurring_occurrence(p_task_id uuid,p_recurrence_key text,
  p_expected_series_version bigint,p_expected_occurrence_version bigint,p_action text,
  p_schedule jsonb default null,p_patch jsonb default null,p_reason text default null)
returns jsonb language plpgsql security definer set search_path = '' set row_security = on as $$
declare root_id uuid; context jsonb; parent_slot jsonb; child jsonb; result jsonb;
  new_day date; days_to_move integer; fold_side text;
begin
  if p_action is null then
    raise exception using errcode='22023', message='Invalid occurrence command';
  end if;
  if p_action is distinct from 'postpone' then
    return ventus_private.mutate_one(p_task_id,p_recurrence_key,p_expected_series_version,
      p_expected_occurrence_version,p_action,p_schedule,p_patch,p_reason);
  end if;
  if p_schedule is null or pg_catalog.octet_length(p_schedule::text)>4096 then
    raise exception using errcode='22023', message='A bounded schedule is required';
  end if;
  root_id:=ventus_private.lock_tree(p_task_id);
  if root_id<>p_task_id then
    return ventus_private.mutate_one(p_task_id,p_recurrence_key,p_expected_series_version,
      p_expected_occurrence_version,p_action,p_schedule,p_patch,p_reason);
  end if;
  context:=public.read_recurrence_context(p_task_id,p_recurrence_key);
  if (context->>'root_version')::bigint is distinct from p_expected_series_version then
    raise exception using errcode='40001', message='Series changed; refetch';
  end if;
  select value into strict parent_slot from pg_catalog.jsonb_array_elements(context->'nodes') node(value)
    where node.value->>'task_id'=p_task_id::text;
  select scheduled_date into strict new_day from ventus_private.read_slot(p_schedule);
  days_to_move:=new_day-(parent_slot->>'scheduled_date')::date;
  fold_side:=coalesce(context->'rule'->>'fold_side','earlier');
  result:=ventus_private.mutate_one(p_task_id,p_recurrence_key,p_expected_series_version,
    p_expected_occurrence_version,p_action,p_schedule,p_patch,p_reason);
  if days_to_move<>0 then
    for child in select value from pg_catalog.jsonb_array_elements(context->'nodes') node(value)
      where node.value->>'task_id'<>p_task_id::text
        and coalesce(node.value->>'status','open')='open'
    loop
      perform ventus_private.mutate_one((child->>'task_id')::uuid,p_recurrence_key,
        p_expected_series_version,coalesce((child->>'version')::bigint,0),'postpone',
        ventus_private.shift_occurrence_slot(child,days_to_move,fold_side),null,null);
    end loop;
  end if;
  return result;
end;
$$;
revoke all on function public.mutate_recurring_occurrence(uuid,text,bigint,bigint,text,jsonb,jsonb,text)
  from public,anon,authenticated,service_role;
alter function public.mutate_recurring_occurrence(uuid,text,bigint,bigint,text,jsonb,jsonb,text)
  owner to ventus_writer;
grant execute on function public.mutate_recurring_occurrence(uuid,text,bigint,bigint,text,jsonb,jsonb,text)
  to authenticated;

revoke create on schema ventus_private from ventus_writer;
revoke create on schema public from ventus_writer;
commit;
