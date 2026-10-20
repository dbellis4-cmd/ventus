-- DRAFT / DESIGN ONLY. Tested on disposable local PostgreSQL 17; NEVER applied hosted.
-- Replaces the never-applied six-table draft. Not an upgrade for an existing DB.
-- Read ../SCHEMA.md and ../tests/PLAN.md before any isolated test application.
begin;

create role ventus_writer nologin noinherit nobypassrls;
grant ventus_writer to postgres;
create schema ventus_private;
revoke all on schema ventus_private from public, anon, authenticated, service_role;
grant usage on schema public, ventus_private to ventus_writer;
grant execute on function auth.uid() to ventus_writer;

-- Resolve auth.uid at definition time: the local reset/restart sequence did not
-- retain managed auth-schema USAGE. Invoker security and the request UID remain unchanged;
-- no runtime auth-schema lookup or elevated definer privileges are required.
create function ventus_private.request_user_id() returns uuid
language sql stable security invoker set search_path = '' return auth.uid();

create table public.user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  timezone text not null,
  appearance text not null default 'system' check (appearance in ('system', 'light', 'dark')),
  defaults_initialized_at timestamptz,
  version bigint not null default 1 check (version > 0),
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp()
);

create table public.categories (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.user_settings(user_id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 80 and name = btrim(name)),
  behavior text not null check (behavior in ('fixed', 'flexible', 'deadline')),
  calendar_default boolean not null default false,
  seed_key text check (seed_key in ('classes', 'meetings', 'assignments', 'professional', 'social', 'personal', 'misc')),
  archived_at timestamptz,
  version bigint not null default 1 check (version > 0),
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  unique (owner_id, id),
  unique (owner_id, seed_key)
);
create unique index categories_active_name_uq on public.categories (owner_id, lower(name)) where archived_at is null;

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.user_settings(user_id) on delete cascade,
  category_id uuid not null,
  parent_task_id uuid,
  title text not null check (char_length(btrim(title)) between 1 and 240 and title = btrim(title)),
  location text check (char_length(location) <= 1000),
  behavior_override text check (behavior_override in ('fixed', 'flexible', 'deadline')),
  calendar_opt_in boolean not null,
  -- Only the top node of one creation request carries a retry key/fingerprint.
  creation_key uuid,
  creation_fingerprint bytea,
  deleted_at timestamptz,
  version bigint not null default 1 check (version > 0),
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  unique (owner_id, id),
  unique (owner_id, creation_key),
  check ((creation_key is null) = (creation_fingerprint is null)),
  check (creation_fingerprint is null or octet_length(creation_fingerprint) = 32),
  check (parent_task_id is distinct from id),
  -- Deferred cross-references allow whole-account erasure regardless of cascade order.
  foreign key (owner_id, category_id) references public.categories(owner_id, id)
    on delete no action deferrable initially deferred,
  foreign key (owner_id, parent_task_id) references public.tasks(owner_id, id)
    on delete no action deferrable initially deferred
);
create index tasks_parent_idx on public.tasks (owner_id, parent_task_id);
create index tasks_category_idx on public.tasks (owner_id, category_id);

create table public.task_occurrences (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.user_settings(user_id) on delete cascade,
  task_id uuid not null,
  recurrence_key text not null default 'once' check (recurrence_key = 'once'),
  parent_occurrence_id uuid,
  original_date date not null,
  original_timezone text not null,
  original_start_time time without time zone,
  original_end_date date,
  original_end_time time without time zone,
  original_starts_at timestamptz,
  original_ends_at timestamptz,
  scheduled_date date not null,
  timezone text not null,
  start_time time without time zone,
  end_date date,
  end_time time without time zone,
  starts_at timestamptz,
  ends_at timestamptz,
  definition_snapshot jsonb not null check (jsonb_typeof(definition_snapshot) = 'object'),
  status text not null default 'open' check (status in ('open', 'completed', 'canceled')),
  completed_at timestamptz check (isfinite(completed_at)),
  completion_recorded_at timestamptz,
  canceled_at timestamptz,
  cancellation_reason text check (char_length(cancellation_reason) <= 500),
  deleted_at timestamptz,
  version bigint not null default 1 check (version > 0),
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  unique (owner_id, id),
  unique (owner_id, task_id, id),
  unique (task_id, recurrence_key),
  check (parent_occurrence_id is distinct from id),
  check ((status = 'completed' and completed_at is not null and completion_recorded_at is not null and completed_at <= completion_recorded_at) or
         (status <> 'completed' and completed_at is null and completion_recorded_at is null)),
  check ((status = 'canceled' and canceled_at is not null) or
         (status <> 'canceled' and canceled_at is null and cancellation_reason is null)),
  foreign key (owner_id, task_id) references public.tasks(owner_id, id)
    on delete no action deferrable initially deferred,
  foreign key (owner_id, parent_occurrence_id) references public.task_occurrences(owner_id, id)
    on delete no action deferrable initially deferred
);
create index task_occurrences_day_idx on public.task_occurrences (owner_id, scheduled_date, starts_at, id) where deleted_at is null;
create index task_occurrences_open_original_idx on public.task_occurrences (owner_id, original_date, id) where status = 'open' and deleted_at is null;
create index task_occurrences_parent_idx on public.task_occurrences (owner_id, parent_occurrence_id);

create table public.task_activity (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.user_settings(user_id) on delete cascade,
  task_id uuid not null,
  occurrence_id uuid not null,
  occurrence_version bigint not null check (occurrence_version > 0),
  actor_user_id uuid not null,
  action text not null check (action in ('created', 'edited', 'completed', 'completion_corrected', 'reopened', 'postponed', 'canceled', 'deleted')),
  effective_at timestamptz not null check (isfinite(effective_at)),
  recorded_at timestamptz not null default statement_timestamp(),
  before_state jsonb check (jsonb_typeof(before_state) = 'object'),
  after_state jsonb not null check (jsonb_typeof(after_state) = 'object'),
  unique (occurrence_id, occurrence_version),
  check (actor_user_id = owner_id),
  check (effective_at <= recorded_at),
  check ((action = 'created' and before_state is null) or (action <> 'created' and before_state is not null)),
  foreign key (owner_id, task_id) references public.tasks(owner_id, id)
    on delete no action deferrable initially deferred,
  foreign key (owner_id, task_id, occurrence_id) references public.task_occurrences(owner_id, task_id, id)
    on delete no action deferrable initially deferred
);
create index task_activity_task_idx on public.task_activity (owner_id, task_id, recorded_at desc, id);

create function ventus_private.valid_timezone(p_zone text) returns boolean
language sql stable security invoker set search_path = '' as $$
  select p_zone is not null and (p_zone = 'UTC' or pg_catalog.strpos(p_zone, '/') > 0)
    and p_zone not like 'posix/%' and p_zone not like 'right/%'
    and exists (select 1 from pg_catalog.pg_timezone_names z where z.name = p_zone);
$$;

-- Round-trip explicit UTC instants instead of silently resolving DST gaps/folds.
create function ventus_private.validate_slot(p_date date, p_zone text, p_start time,
  p_end_date date, p_end time, p_starts_at timestamptz, p_ends_at timestamptz) returns void
language plpgsql security invoker set search_path = '' as $$
begin
  if p_date is null or not pg_catalog.isfinite(p_date) or not ventus_private.valid_timezone(p_zone) then
    raise exception using errcode = '22023', message = 'A finite date and supported IANA timezone are required';
  end if;
  if p_start is null then
    if p_starts_at is not null or p_end_date is not null or p_end is not null or p_ends_at is not null then
      raise exception using errcode = '22023', message = 'Anytime tasks have a date and timezone, without time instants';
    end if;
    return;
  end if;
  if p_start >= time '24:00' or p_starts_at is null or not pg_catalog.isfinite(p_starts_at)
     or (p_starts_at at time zone p_zone)::date is distinct from p_date
     or (p_starts_at at time zone p_zone)::time is distinct from p_start then
    raise exception using errcode = '22023', message = 'Start instant must explicitly match local date, time and timezone';
  end if;
  if p_end_date is null and p_end is null and p_ends_at is null then return; end if;
  if p_end_date is null or not pg_catalog.isfinite(p_end_date) or p_end is null or p_end >= time '24:00'
     or p_ends_at is null or not pg_catalog.isfinite(p_ends_at) or p_ends_at <= p_starts_at
     or (p_ends_at at time zone p_zone)::date is distinct from p_end_date
     or (p_ends_at at time zone p_zone)::time is distinct from p_end then
    raise exception using errcode = '22023', message = 'End instant must match its local date, time and timezone and follow start';
  end if;
end;
$$;

create function ventus_private.guard_versioned_row() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare k text;
begin
  if tg_op = 'INSERT' then
    new.version := 1;
    new.created_at := pg_catalog.clock_timestamp();
  else
    foreach k in array array['id', 'user_id', 'owner_id', 'created_at', 'parent_task_id', 'seed_key', 'creation_key', 'creation_fingerprint'] loop
      if pg_catalog.to_jsonb(new)->k is distinct from pg_catalog.to_jsonb(old)->k then
        raise exception using errcode = '42501', message = 'Immutable identity field';
      end if;
    end loop;
    new.version := old.version + 1;
  end if;
  if tg_table_name in ('tasks', 'task_occurrences') then
    if tg_op = 'INSERT' then new.deleted_at := null;
    elsif old.deleted_at is not null and new.deleted_at is distinct from old.deleted_at then
      raise exception using errcode = '42501', message = 'Deleted records cannot be restored by task mutations';
    elsif old.deleted_at is null and new.deleted_at is not null then new.deleted_at := pg_catalog.clock_timestamp();
    end if;
  elsif tg_table_name = 'categories' then
    if tg_op = 'INSERT' then new.archived_at := null;
    elsif old.archived_at is null and new.archived_at is not null then new.archived_at := pg_catalog.clock_timestamp();
    elsif old.archived_at is not null and new.archived_at is not null then new.archived_at := old.archived_at;
    end if;
  elsif tg_table_name = 'user_settings' then
    if not ventus_private.valid_timezone(new.timezone) then
      raise exception using errcode = '22023', message = 'A supported IANA timezone is required';
    end if;
    if tg_op = 'INSERT' then new.defaults_initialized_at := null;
    elsif old.defaults_initialized_at is not null and new.defaults_initialized_at is distinct from old.defaults_initialized_at then
      raise exception using errcode = '42501', message = 'Initialization marker cannot be reset';
    elsif old.defaults_initialized_at is null and new.defaults_initialized_at is not null then
      new.defaults_initialized_at := pg_catalog.clock_timestamp();
    end if;
  end if;
  new.updated_at := pg_catalog.clock_timestamp();
  return new;
end;
$$;
create trigger user_settings_version before insert or update on public.user_settings for each row execute function ventus_private.guard_versioned_row();
create trigger categories_version before insert or update on public.categories for each row execute function ventus_private.guard_versioned_row();
create trigger tasks_version before insert or update on public.tasks for each row execute function ventus_private.guard_versioned_row();
create trigger task_occurrences_version before insert or update on public.task_occurrences for each row execute function ventus_private.guard_versioned_row();

create function ventus_private.check_task_parent() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare depth integer;
begin
  -- No workspace lock. RPCs lock the immutable hierarchy root before child writes.
  if new.parent_task_id is not null and not exists (
    select 1 from public.tasks p where p.owner_id = new.owner_id and p.id = new.parent_task_id
      and p.deleted_at is null and p.id <> new.id) and new.deleted_at is null then
    raise exception using errcode = '23514', message = 'An existing active parent task is required';
  end if;
  if tg_op = 'INSERT' and new.parent_task_id is not null then
    with recursive ancestors as (
      select t.id,t.parent_task_id,1 as level from public.tasks t where t.owner_id=new.owner_id and t.id=new.parent_task_id
      union all select t.id,t.parent_task_id,a.level+1 from public.tasks t join ancestors a on t.id=a.parent_task_id
        where t.owner_id=new.owner_id and a.level<11
    ) select max(level) into depth from ancestors;
    if depth > 10 then raise exception using errcode='23514', message='Task hierarchy is too deep'; end if;
  end if;
  return new;
end;
$$;
create trigger tasks_parent_integrity before insert or update on public.tasks for each row execute function ventus_private.check_task_parent();

create function ventus_private.guard_occurrence() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare t public.tasks%rowtype;
begin
  select * into strict t from public.tasks where owner_id = new.owner_id and id = new.task_id;
  if tg_op = 'INSERT' then
    if new.recurrence_key is distinct from 'once' then
      raise exception using errcode='0A000', message='Recurrence is unavailable until Milestone 4';
    end if;
    new.original_date := new.scheduled_date; new.original_timezone := new.timezone;
    new.original_start_time := new.start_time; new.original_end_date := new.end_date;
    new.original_end_time := new.end_time; new.original_starts_at := new.starts_at; new.original_ends_at := new.ends_at;
  else
    if (new.task_id, new.recurrence_key, new.parent_occurrence_id, new.original_date, new.original_timezone,
        new.original_start_time, new.original_end_date, new.original_end_time, new.original_starts_at, new.original_ends_at)
       is distinct from
       (old.task_id, old.recurrence_key, old.parent_occurrence_id, old.original_date, old.original_timezone,
        old.original_start_time, old.original_end_date, old.original_end_time, old.original_starts_at, old.original_ends_at) then
      raise exception using errcode = '42501', message = 'Original occurrence identity and deadline are immutable';
    end if;
    if old.status <> 'open' and new.definition_snapshot is distinct from old.definition_snapshot then
      raise exception using errcode = '42501', message = 'Closed occurrence snapshots cannot be rewritten';
    end if;
  end if;
  if (t.parent_task_id is null) <> (new.parent_occurrence_id is null) or
     (new.parent_occurrence_id is not null and not exists (
       select 1 from public.task_occurrences p where p.owner_id = new.owner_id
       and p.id = new.parent_occurrence_id and p.task_id = t.parent_task_id)) then
    raise exception using errcode = '23514', message = 'Subtask must reference its parent occurrence';
  end if;
  perform ventus_private.validate_slot(new.scheduled_date, new.timezone, new.start_time, new.end_date, new.end_time, new.starts_at, new.ends_at);
  if new.status = 'completed' then
    if tg_op = 'INSERT' or old.status <> 'completed' or new.completed_at is distinct from old.completed_at then
      new.completion_recorded_at := pg_catalog.clock_timestamp();
    else new.completion_recorded_at := old.completion_recorded_at; end if;
  else new.completion_recorded_at := null;
  end if;
  if new.status = 'canceled' then
    if tg_op = 'INSERT' or old.status <> 'canceled' then new.canceled_at := pg_catalog.clock_timestamp();
    else new.canceled_at := old.canceled_at; end if;
  else new.canceled_at := null;
  end if;
  return new;
end;
$$;
create trigger task_occurrences_integrity before insert or update on public.task_occurrences for each row execute function ventus_private.guard_occurrence();

-- The sole privileged trigger exception: permits erasure ONLY once auth.users is
-- absent. It cannot be called as an API/RPC and never grants DELETE to the writer.
-- postgres ownership is required to inspect auth.users during an Auth-admin cascade.
create function ventus_private.guard_activity() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if not exists (select 1 from auth.users u where u.id = old.owner_id) then return old; end if;
    raise exception using errcode = '42501', message = 'History can be erased only with permanent account deletion';
  elsif tg_op = 'UPDATE' then
    raise exception using errcode = '42501', message = 'Task activity is append-only';
  end if;
  new.actor_user_id := new.owner_id;
  new.recorded_at := pg_catalog.clock_timestamp();
  return new;
end;
$$;
alter function ventus_private.guard_activity() owner to postgres;
create trigger task_activity_append_only before insert or update or delete on public.task_activity for each row execute function ventus_private.guard_activity();

alter table public.user_settings enable row level security;
alter table public.user_settings force row level security;
alter table public.categories enable row level security;
alter table public.categories force row level security;
alter table public.tasks enable row level security;
alter table public.tasks force row level security;
alter table public.task_occurrences enable row level security;
alter table public.task_occurrences force row level security;
alter table public.task_activity enable row level security;
alter table public.task_activity force row level security;

revoke all on public.user_settings, public.categories, public.tasks, public.task_occurrences, public.task_activity from public, anon, authenticated, service_role;
grant select on public.user_settings, public.categories, public.tasks, public.task_occurrences, public.task_activity to authenticated, ventus_writer;
grant insert, update on public.user_settings, public.categories, public.tasks, public.task_occurrences to ventus_writer;
grant insert on public.task_activity to ventus_writer;

create policy settings_read on public.user_settings for select to authenticated, ventus_writer using ((select auth.uid()) = user_id);
create policy settings_insert on public.user_settings for insert to ventus_writer with check ((select auth.uid()) = user_id);
create policy settings_update on public.user_settings for update to ventus_writer using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy categories_read on public.categories for select to authenticated, ventus_writer using ((select auth.uid()) = owner_id);
create policy categories_insert on public.categories for insert to ventus_writer with check ((select auth.uid()) = owner_id);
create policy categories_update on public.categories for update to ventus_writer using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
create policy tasks_read on public.tasks for select to authenticated, ventus_writer using ((select auth.uid()) = owner_id);
create policy tasks_insert on public.tasks for insert to ventus_writer with check ((select auth.uid()) = owner_id);
create policy tasks_update on public.tasks for update to ventus_writer using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
create policy occurrences_read on public.task_occurrences for select to authenticated, ventus_writer using ((select auth.uid()) = owner_id);
create policy occurrences_insert on public.task_occurrences for insert to ventus_writer with check ((select auth.uid()) = owner_id);
create policy occurrences_update on public.task_occurrences for update to ventus_writer using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
create policy activity_read on public.task_activity for select to authenticated, ventus_writer using ((select auth.uid()) = owner_id);
create policy activity_insert on public.task_activity for insert to ventus_writer with check ((select auth.uid()) = owner_id);

revoke all on all functions in schema ventus_private from public, anon, authenticated, service_role;
grant execute on all functions in schema ventus_private to ventus_writer;
commit;
