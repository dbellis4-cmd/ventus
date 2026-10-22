-- Existing Calendar-only grants cannot identify a Google subject. Require a fresh
-- OIDC authorization before those connections can resume synchronization.
begin;

alter table public.google_calendar_connections add column google_sub text;
alter table public.google_calendar_connections drop constraint google_calendar_connections_status_check;
alter table public.google_calendar_connections add constraint google_calendar_connections_status_check
  check (status in ('connected','disconnected','reauthorize','disconnecting'));
update public.google_calendar_connections set status='reauthorize', refresh_token_ciphertext=null,
  sync_token=null, lease_id=null, lease_until=null, last_error='Reconnect Google Calendar to verify the Google account.'
  where status='connected';
alter table public.google_calendar_connections add constraint google_connected_subject_check
  check (status<>'connected' or google_sub is not null);
alter table public.google_calendar_connections add constraint google_subject_not_blank_check
  check (google_sub is null or length(google_sub) between 1 and 255);
create unique index google_calendar_connections_google_sub_key
  on public.google_calendar_connections(google_sub) where google_sub is not null;

commit;
