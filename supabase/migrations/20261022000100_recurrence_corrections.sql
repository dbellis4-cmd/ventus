begin;

grant create on schema public to ventus_writer;
grant create on schema ventus_private to ventus_writer;

-- A stored parent exception remains authoritative even when its original rule
-- was revised. Without one, the parent's local slot must actually exist.
create function ventus_private.recurring_parent_available(p_root_id uuid, p_key text)
returns boolean language plpgsql stable security invoker set search_path = '' as $$
declare parent public.task_occurrences%rowtype; rule public.task_recurrence_revisions%rowtype;
  starts timestamptz; ends timestamptz;
begin
  select * into parent from public.task_occurrences
    where owner_id=ventus_private.request_user_id() and task_id=p_root_id
      and recurrence_key=p_key;
  if found then return parent.deleted_at is null; end if;
  if p_key is null or p_key !~ '^\d{4}-\d{2}-\d{2}$' then return false; end if;
  select * into rule from ventus_private.recurrence_revision(p_root_id,p_key::date);
  if rule.id is null then return false; end if;
  starts:=case when rule.start_time is null then null else
    ventus_private.recurrence_instant(p_key::date,rule.start_time,rule.timezone,rule.fold_side) end;
  ends:=case when rule.end_time is null then null else
    ventus_private.recurrence_instant(p_key::date+rule.end_day_offset,rule.end_time,rule.timezone,rule.fold_side) end;
  return (rule.start_time is null or starts is not null) and
    (rule.end_time is null or (ends is not null and ends>starts));
end;
$$;
revoke all on function ventus_private.recurring_parent_available(uuid,text)
  from public,anon,authenticated,service_role;
grant execute on function ventus_private.recurring_parent_available(uuid,text) to ventus_writer;

-- Keep the original bounded generator as a private implementation. Both the
-- Dashboard and occurrence editor now receive only valid child candidates.
alter function public.list_recurrence_candidates(date,date) set schema ventus_private;
alter function ventus_private.list_recurrence_candidates(date,date) rename to list_candidates_unchecked;
revoke all on function ventus_private.list_candidates_unchecked(date,date)
  from public,anon,authenticated,service_role;

create function public.list_recurrence_candidates(p_from date,p_to date)
returns setof jsonb language sql stable security definer set search_path = '' set row_security = on as $$
  select candidate.value from ventus_private.list_candidates_unchecked(p_from,p_to) candidate(value)
  where candidate.value->>'parent_task_id' is null or
    ventus_private.recurring_parent_available(
      (candidate.value->>'parent_task_id')::uuid,candidate.value->>'recurrence_key');
$$;
revoke all on function public.list_recurrence_candidates(date,date)
  from public,anon,authenticated,service_role;
alter function public.list_recurrence_candidates(date,date) owner to ventus_writer;
grant execute on function public.list_recurrence_candidates(date,date) to authenticated;

-- Scalar JSON avoids PostgREST's row cap; keyset paging keeps every reply small.
create function public.list_recurrence_candidates_page(p_from date,p_to date,
  p_after_task_id text default null,p_after_key text default null)
returns jsonb language plpgsql stable security definer set search_path = '' set row_security = on as $$
begin
  if (p_after_task_id is null) is distinct from (p_after_key is null) then
    raise exception using errcode='22023', message='Invalid recurrence page cursor';
  end if;
  return coalesce((select pg_catalog.jsonb_agg(page.value order by page.task_id,page.key)
    from (select candidate.value,candidate.value->>'task_id' as task_id,
        candidate.value->>'recurrence_key' as key
      from public.list_recurrence_candidates(p_from,p_to) candidate(value)
      where p_after_task_id is null or
        (candidate.value->>'task_id',candidate.value->>'recurrence_key') >
        (p_after_task_id,p_after_key)
      order by task_id,key limit 100) page),'[]'::jsonb);
end;
$$;
revoke all on function public.list_recurrence_candidates_page(date,date,text,text)
  from public,anon,authenticated,service_role;
alter function public.list_recurrence_candidates_page(date,date,text,text) owner to ventus_writer;
grant execute on function public.list_recurrence_candidates_page(date,date,text,text) to authenticated;

-- The public parent action is the only API entry point. The private helper is
-- also used for children inside the parent transaction.
create or replace function public.mutate_recurring_occurrence(p_task_id uuid,p_recurrence_key text,
  p_expected_series_version bigint,p_expected_occurrence_version bigint,p_action text,
  p_schedule jsonb default null,p_patch jsonb default null,p_reason text default null)
returns jsonb language plpgsql security definer set search_path = '' set row_security = on as $$
declare root_id uuid; context jsonb; parent_slot jsonb; child jsonb; result jsonb;
  new_day date; days_to_move integer; fold_side text;
begin
  if p_action is null then
    raise exception using errcode='22023', message='Invalid occurrence command';
  end if;
  root_id:=ventus_private.lock_tree(p_task_id);
  if root_id<>p_task_id and p_recurrence_key<>'once' and not
     ventus_private.recurring_parent_available(root_id,p_recurrence_key) then
    raise exception using errcode='P0002', message='Parent occurrence unavailable';
  end if;
  if p_action not in ('postpone','edit') or p_schedule is null or root_id<>p_task_id then
    return ventus_private.mutate_one(p_task_id,p_recurrence_key,p_expected_series_version,
      p_expected_occurrence_version,p_action,p_schedule,p_patch,p_reason);
  end if;
  if pg_catalog.octet_length(p_schedule::text)>4096 then
    raise exception using errcode='22023', message='A bounded schedule is required';
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

-- Wrap the legacy editor so parent date edits move existing open descendants in
-- the same transaction. Explicit child schedules and newly added children stay
-- at the dates the caller supplied.
alter function public.edit_task_tree(uuid,bigint,jsonb,jsonb,jsonb) set schema ventus_private;
alter function ventus_private.edit_task_tree(uuid,bigint,jsonb,jsonb,jsonb) rename to edit_tree_one;
revoke all on function ventus_private.edit_tree_one(uuid,bigint,jsonb,jsonb,jsonb)
  from public,anon,authenticated,service_role;

create function public.edit_task_tree(p_root_task_id uuid,p_expected_root_version bigint,
  p_edits jsonb,p_new_subtasks jsonb default '[]'::jsonb,p_delete_subtasks jsonb default '[]'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' set row_security = on as $$
declare actor uuid:=ventus_private.request_user_id(); edit_item jsonb; move_item jsonb;
  moves jsonb:='[]'::jsonb; existing_ids uuid[]; old_day date; new_day date;
  child record; result jsonb;
begin
  if actor is null then raise exception using errcode='42501', message='Authentication required'; end if;
  perform ventus_private.lock_tree(p_root_task_id);
  with recursive tree as (
    select id from public.tasks where owner_id=actor and id=p_root_task_id
    union all select t.id from public.tasks t join tree on t.parent_task_id=tree.id
      where t.owner_id=actor
  ) select coalesce(pg_catalog.array_agg(id),'{}'::uuid[]) into existing_ids from tree;
  for edit_item in select value from pg_catalog.jsonb_array_elements(p_edits) loop
    if edit_item->'patch' ? 'schedule' then
      select o.scheduled_date into old_day from public.task_occurrences o
        where o.owner_id=actor and o.task_id=(edit_item->>'task_id')::uuid
          and o.recurrence_key='once';
      select scheduled_date into strict new_day from ventus_private.read_slot(edit_item->'patch'->'schedule');
      if old_day is not null and new_day<>old_day then
        moves:=moves || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
          'task_id',edit_item->>'task_id','days',new_day-old_day));
      end if;
    end if;
  end loop;
  result:=ventus_private.edit_tree_one(p_root_task_id,p_expected_root_version,
    p_edits,p_new_subtasks,p_delete_subtasks);
  for move_item in select value from pg_catalog.jsonb_array_elements(moves) loop
    for child in
      with recursive descendants as (
        select t.id,1 as depth from public.tasks t
          where t.owner_id=actor and t.parent_task_id=(move_item->>'task_id')::uuid
            and not exists(select 1 from pg_catalog.jsonb_array_elements(p_edits) e(value)
              where e.value->>'task_id'=t.id::text and e.value->'patch' ? 'schedule')
        union all
        select t.id,d.depth+1 from public.tasks t join descendants d on t.parent_task_id=d.id
          where t.owner_id=actor and d.depth<100
            and not exists(select 1 from pg_catalog.jsonb_array_elements(p_edits) e(value)
              where e.value->>'task_id'=t.id::text and e.value->'patch' ? 'schedule')
      )
      select t.id,t.version as task_version,o.version as occurrence_version,
        pg_catalog.to_jsonb(o) as slot from descendants d
        join public.tasks t on t.owner_id=actor and t.id=d.id
        join public.task_occurrences o on o.owner_id=actor and o.task_id=t.id
      where t.id=any(existing_ids) and t.deleted_at is null and o.deleted_at is null
        and o.status='open' and o.recurrence_key='once'
      order by d.depth,t.id
    loop
      perform ventus_private.postpone_one(child.id,child.task_version,child.occurrence_version,
        ventus_private.shift_occurrence_slot(child.slot,(move_item->>'days')::integer,'earlier'));
    end loop;
  end loop;
  return result || pg_catalog.jsonb_build_object('root_version',
    (select version from public.tasks where owner_id=actor and id=p_root_task_id));
end;
$$;
revoke all on function public.edit_task_tree(uuid,bigint,jsonb,jsonb,jsonb)
  from public,anon,authenticated,service_role;
alter function public.edit_task_tree(uuid,bigint,jsonb,jsonb,jsonb) owner to ventus_writer;
grant execute on function public.edit_task_tree(uuid,bigint,jsonb,jsonb,jsonb) to authenticated;

revoke create on schema ventus_private from ventus_writer;
revoke create on schema public from ventus_writer;
commit;
