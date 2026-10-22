-- Local Milestone 5 draft. Apply to hosted development only after separate approval.
begin;

grant create on schema public to ventus_writer;

create table public.google_calendar_connections (
  owner_id uuid primary key references public.user_settings(user_id) on delete cascade,
  status text not null check (status in ('connected','disconnected','reauthorize')),
  calendar_id text,
  refresh_token_ciphertext text,
  sync_token text,
  generation bigint not null default 1,
  lease_id uuid,
  lease_until timestamptz,
  last_synced_at timestamptz,
  last_error text,
  updated_at timestamptz not null default clock_timestamp(),
  check ((status='connected') = (calendar_id is not null and refresh_token_ciphertext is not null))
);

create table public.google_calendar_links (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.user_settings(user_id) on delete cascade,
  task_id uuid not null,
  recurrence_key text not null,
  calendar_id text,
  event_id text not null default ('v' || replace(gen_random_uuid()::text,'-','')),
  override_opt_in boolean,
  state text not null default 'absent' check (state in ('absent','active','suppressed','error')),
  etag text,
  mapped_snapshot jsonb,
  last_error text,
  updated_at timestamptz not null default clock_timestamp(),
  unique (owner_id,task_id,recurrence_key),
  unique (calendar_id,event_id),
  foreign key (owner_id,task_id) references public.tasks(owner_id,id) on delete cascade
);
create index google_calendar_links_task_idx on public.google_calendar_links(owner_id,task_id);

create table public.google_calendar_dirty (
  owner_id uuid not null references public.user_settings(user_id) on delete cascade,
  task_id uuid not null,
  queued_at timestamptz not null default clock_timestamp(),
  next_attempt_at timestamptz not null default clock_timestamp(),
  attempts integer not null default 0,
  primary key(owner_id,task_id),
  foreign key(owner_id,task_id) references public.tasks(owner_id,id) on delete cascade
);
create index google_calendar_dirty_due_idx on public.google_calendar_dirty(next_attempt_at,owner_id);

alter table public.google_calendar_connections enable row level security;
alter table public.google_calendar_connections force row level security;
alter table public.google_calendar_links enable row level security;
alter table public.google_calendar_links force row level security;
alter table public.google_calendar_dirty enable row level security;
alter table public.google_calendar_dirty force row level security;
revoke all on public.google_calendar_connections, public.google_calendar_links, public.google_calendar_dirty from public,anon,authenticated,service_role;
grant select,insert,update,delete on public.google_calendar_connections, public.google_calendar_links, public.google_calendar_dirty to service_role;
-- The server-only sync reads these projections across owners; task writes still use authenticated RPCs.
grant select(user_id,timezone,defaults_initialized_at) on public.user_settings to service_role;
grant select(id,owner_id,parent_task_id,title,location,calendar_opt_in,recurrence_enabled,deleted_at) on public.tasks to service_role;
grant select(id,owner_id,task_id,recurrence_key,status,deleted_at,scheduled_date,timezone,start_time,starts_at,end_date,end_time,ends_at,definition_snapshot) on public.task_occurrences to service_role;
grant select(id,owner_id,task_id,effective_from,stopped) on public.task_recurrence_revisions to service_role;
grant select(owner_id,status,calendar_id) on public.google_calendar_connections to ventus_writer;
grant select,insert,update on public.google_calendar_links to ventus_writer;
grant select on public.google_calendar_links to authenticated;
grant select,insert,update on public.google_calendar_dirty to ventus_writer;
create policy google_connection_writer_status on public.google_calendar_connections for select to ventus_writer
  using (owner_id=(select auth.uid()));
create policy google_links_read on public.google_calendar_links for select to authenticated,ventus_writer
  using (owner_id=(select auth.uid()));
create policy google_links_insert on public.google_calendar_links for insert to ventus_writer
  with check (owner_id=(select auth.uid()));
create policy google_links_update on public.google_calendar_links for update to ventus_writer
  using (owner_id=(select auth.uid())) with check (owner_id=(select auth.uid()));
create policy google_dirty_insert on public.google_calendar_dirty for insert to ventus_writer
  with check (owner_id=(select auth.uid()));
create policy google_dirty_read on public.google_calendar_dirty for select to ventus_writer
  using (owner_id=(select auth.uid()));
create policy google_dirty_update on public.google_calendar_dirty for update to ventus_writer
  using (owner_id=(select auth.uid())) with check (owner_id=(select auth.uid()));

create function ventus_private.queue_google_task() returns trigger
language plpgsql security invoker set search_path='' as $$
declare actor uuid; root_id uuid;
begin
  actor:=new.owner_id;
  if not exists(select 1 from public.google_calendar_connections c where c.owner_id=actor and c.status='connected') then
    return new;
  end if;
  if tg_table_name='tasks' then
    root_id:=coalesce(new.parent_task_id,new.id);
  elsif tg_table_name='task_occurrences' then
    select coalesce(t.parent_task_id,t.id) into root_id from public.tasks t
      where t.owner_id=actor and t.id=new.task_id;
  else
    root_id:=new.task_id;
  end if;
  if root_id is not null then
    insert into public.google_calendar_dirty(owner_id,task_id) values(actor,root_id)
    on conflict(owner_id,task_id) do update set queued_at=clock_timestamp(),next_attempt_at=clock_timestamp(),attempts=0;
  end if;
  return new;
end;
$$;
create trigger google_dirty_tasks after insert or update on public.tasks for each row execute function ventus_private.queue_google_task();
create trigger google_dirty_occurrences after insert or update on public.task_occurrences for each row execute function ventus_private.queue_google_task();
create trigger google_dirty_revisions after insert or update on public.task_recurrence_revisions for each row execute function ventus_private.queue_google_task();

-- Keep the existing recurrence validation/history transaction and add an owned
-- per-occurrence calendar choice within that same transaction.
alter function public.mutate_recurring_occurrence(uuid,text,bigint,bigint,text,jsonb,jsonb,text) set schema ventus_private;
alter function ventus_private.mutate_recurring_occurrence(uuid,text,bigint,bigint,text,jsonb,jsonb,text) rename to google_mutate_base;
create function public.mutate_recurring_occurrence(p_task_id uuid,p_recurrence_key text,
  p_expected_series_version bigint,p_expected_occurrence_version bigint,p_action text,
  p_schedule jsonb default null,p_patch jsonb default null,p_reason text default null)
returns jsonb language plpgsql security definer set search_path='' set row_security=on as $$
declare actor uuid:=ventus_private.request_user_id(); result jsonb; preference boolean;
  current_link public.google_calendar_links%rowtype; calendar text;
begin
  if p_action='edit' and p_patch ? 'calendar_opt_in' then
    if pg_catalog.jsonb_typeof(p_patch->'calendar_opt_in')<>'boolean' then
      raise exception using errcode='22023',message='Invalid calendar preference';
    end if;
    preference:=(p_patch->>'calendar_opt_in')::boolean;
    p_patch:=p_patch-'calendar_opt_in';
  end if;
  result:=ventus_private.google_mutate_base(p_task_id,p_recurrence_key,p_expected_series_version,
    p_expected_occurrence_version,p_action,p_schedule,p_patch,p_reason);
  if preference is not null then
    select calendar_id into calendar from public.google_calendar_connections
      where owner_id=actor and status='connected';
    select * into current_link from public.google_calendar_links
      where owner_id=actor and task_id=p_task_id and recurrence_key=p_recurrence_key for update;
    if current_link.id is null then
      insert into public.google_calendar_links(owner_id,task_id,recurrence_key,calendar_id,override_opt_in)
        values(actor,p_task_id,p_recurrence_key,calendar,preference);
    else
      update public.google_calendar_links set override_opt_in=preference,
        event_id=case when preference and current_link.override_opt_in=false then
          'v' || replace(gen_random_uuid()::text,'-','') else event_id end,
        state=case when preference and current_link.override_opt_in=false then 'absent' else state end,
        etag=case when preference and current_link.override_opt_in=false then null else etag end,
        mapped_snapshot=case when preference and current_link.override_opt_in=false then null else mapped_snapshot end,
        updated_at=clock_timestamp() where id=current_link.id;
    end if;
  end if;
  return result;
end;
$$;
revoke all on function public.mutate_recurring_occurrence(uuid,text,bigint,bigint,text,jsonb,jsonb,text)
  from public,anon,authenticated,service_role;
alter function public.mutate_recurring_occurrence(uuid,text,bigint,bigint,text,jsonb,jsonb,text) owner to ventus_writer;
grant execute on function public.mutate_recurring_occurrence(uuid,text,bigint,bigint,text,jsonb,jsonb,text) to authenticated;

alter function public.change_recurring_series(uuid,bigint,date,boolean,jsonb,jsonb,text,uuid,text) set schema ventus_private;
alter function ventus_private.change_recurring_series(uuid,bigint,date,boolean,jsonb,jsonb,text,uuid,text) rename to google_series_base;
create function public.change_recurring_series(p_task_id uuid,p_expected_series_version bigint,
  p_from_date date,p_stop boolean,p_rule jsonb default null,p_schedule jsonb default null,
  p_title text default null,p_category_id uuid default null,p_location text default null,
  p_calendar_opt_in boolean default null)
returns jsonb language plpgsql security definer set search_path='' set row_security=on as $$
declare actor uuid:=ventus_private.request_user_id(); result jsonb; next_revision integer;
begin
  result:=ventus_private.google_series_base(p_task_id,p_expected_series_version,p_from_date,p_stop,
    p_rule,p_schedule,p_title,p_category_id,p_location);
  if not p_stop and p_calendar_opt_in is not null then
    update public.tasks set calendar_opt_in=p_calendar_opt_in where owner_id=actor and id=p_task_id;
    select max(revision) into next_revision from public.task_recurrence_revisions where owner_id=actor and task_id=p_task_id;
    update public.task_recurrence_revisions set definition_snapshot=jsonb_set(definition_snapshot,
      '{calendar_opt_in}',to_jsonb(p_calendar_opt_in))
      where owner_id=actor and task_id=p_task_id and revision=next_revision;
  end if;
  return result;
end;
$$;
revoke all on function public.change_recurring_series(uuid,bigint,date,boolean,jsonb,jsonb,text,uuid,text,boolean)
  from public,anon,authenticated,service_role;
alter function public.change_recurring_series(uuid,bigint,date,boolean,jsonb,jsonb,text,uuid,text,boolean) owner to ventus_writer;
grant execute on function public.change_recurring_series(uuid,bigint,date,boolean,jsonb,jsonb,text,uuid,text,boolean) to authenticated;

-- The existing tree transaction remains authoritative; this only clears a
-- Google-side deletion override when the owner explicitly changes the checkbox.
alter function public.edit_task_tree(uuid,bigint,jsonb,jsonb,jsonb) set schema ventus_private;
alter function ventus_private.edit_task_tree(uuid,bigint,jsonb,jsonb,jsonb) rename to google_edit_tree_base;
create function public.edit_task_tree(p_root_task_id uuid,p_expected_root_version bigint,p_edits jsonb,
  p_new_subtasks jsonb default '[]'::jsonb,p_delete_subtasks jsonb default '[]'::jsonb)
returns jsonb language plpgsql security definer set search_path='' set row_security=on as $$
declare actor uuid:=ventus_private.request_user_id(); result jsonb; item jsonb; target uuid;
begin
  result:=ventus_private.google_edit_tree_base(p_root_task_id,p_expected_root_version,
    p_edits,p_new_subtasks,p_delete_subtasks);
  for item in select value from pg_catalog.jsonb_array_elements(p_edits) loop
    if item->'patch' ? 'calendar_opt_in' then
      target:=(item->>'task_id')::uuid;
      update public.google_calendar_links set override_opt_in=null,
        event_id=case when state='suppressed' then 'v' || replace(gen_random_uuid()::text,'-','') else event_id end,
        state=case when state='suppressed' then 'absent' else state end,
        etag=case when state='suppressed' then null else etag end,
        mapped_snapshot=case when state='suppressed' then null else mapped_snapshot end,
        updated_at=clock_timestamp()
        where owner_id=actor and task_id=target and recurrence_key='once';
    end if;
  end loop;
  return result;
end;
$$;
revoke all on function public.edit_task_tree(uuid,bigint,jsonb,jsonb,jsonb) from public,anon,authenticated,service_role;
alter function public.edit_task_tree(uuid,bigint,jsonb,jsonb,jsonb) owner to ventus_writer;
grant execute on function public.edit_task_tree(uuid,bigint,jsonb,jsonb,jsonb) to authenticated;

-- Only the server's service key can ask for another user's virtual occurrences.
create function public.google_calendar_candidates(p_owner_id uuid,p_from date,p_to date)
returns jsonb language plpgsql stable security definer set search_path='' set row_security=on as $$
declare window_start date:=p_from; page jsonb; result jsonb:='[]'::jsonb;
begin
  if p_owner_id is null or p_from is null or p_to is null or p_to<p_from or p_to-p_from>366 then
    raise exception using errcode='22023',message='Invalid calendar candidate window';
  end if;
  if auth.role()<>'service_role' then
    raise exception using errcode='42501',message='Service authorization required';
  end if;
  perform pg_catalog.set_config('request.jwt.claim.sub',p_owner_id::text,true);
  while window_start<=p_to loop
    select coalesce(pg_catalog.jsonb_agg(candidate.value order by
      candidate.value->>'scheduled_date',candidate.value->>'task_id'),'[]'::jsonb)
      into page from public.list_recurrence_candidates(window_start,least(window_start+6,p_to)) candidate(value);
    result:=result||page;
    -- shortcut: bound a personal calendar to 10,000 projected occurrences; page in SQL if real usage reaches this size.
    if pg_catalog.jsonb_array_length(result)>10000 then
      raise exception using errcode='54000',message='Calendar candidate limit exceeded';
    end if;
    window_start:=window_start+7;
  end loop;
  return result;
end;
$$;
revoke all on function public.google_calendar_candidates(uuid,date,date)
  from public,anon,authenticated,service_role;
grant execute on function public.google_calendar_candidates(uuid,date,date) to service_role;

create function public.google_calendar_due_owners(p_limit integer default 10)
returns setof uuid language plpgsql stable security definer set search_path='' as $$
begin
  if auth.role()<>'service_role' then
    raise exception using errcode='42501',message='Service authorization required';
  end if;
  return query select c.owner_id from public.google_calendar_connections c
    where c.status='connected' and (
      c.last_synced_at is null or c.last_synced_at<clock_timestamp()-interval '1 day' or
      exists(select 1 from public.google_calendar_dirty d where d.owner_id=c.owner_id
        and d.next_attempt_at<=clock_timestamp()))
    order by c.last_synced_at nulls first
    limit least(greatest(p_limit,1),10);
end;
$$;
revoke all on function public.google_calendar_due_owners(integer) from public,anon,authenticated,service_role;
grant execute on function public.google_calendar_due_owners(integer) to service_role;

revoke create on schema public from ventus_writer;

commit;
