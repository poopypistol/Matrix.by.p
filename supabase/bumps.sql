-- declan: Slack bumps. Run once in Supabase > SQL Editor, after deploying the send-bumps function.

-- Remembers which bumps already went out, so each one is sent once.
create table if not exists public.bump_sent (
  email text not null,
  post_id text not null,
  slot timestamptz not null,
  sent_at timestamptz not null default now(),
  primary key (email, post_id, slot)
);
alter table public.bump_sent enable row level security; -- no policies: only the server can read or write it

-- Checks for due bumps every 5 minutes.
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

select cron.unschedule('declan-bumps') where exists (select 1 from cron.job where jobname = 'declan-bumps');
select cron.schedule(
  'declan-bumps',
  '*/5 * * * *',
  $$ select net.http_post(
       url := 'https://wwehsdjcgvkbteeahpkv.supabase.co/functions/v1/send-bumps',
       headers := '{"Content-Type": "application/json"}'::jsonb,
       body := '{}'::jsonb
     ) $$
);
