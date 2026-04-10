create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule(jobid) from cron.job where jobname = 'signal-desk-daily-setup';
select cron.unschedule(jobid) from cron.job where jobname = 'signal-desk-monitor-1630-1659';
select cron.unschedule(jobid) from cron.job where jobname = 'signal-desk-monitor-1700-1730';
select cron.unschedule(jobid) from cron.job where jobname = 'signal-desk-recompute-learning';
select cron.unschedule(jobid) from cron.job where jobname = 'signal-desk-resolve-trades';

-- Supabase Cron schedules run in UTC.
-- On April 9, 2026, Europe/Oslo is UTC+2 (CEST),
-- so 16:30-17:30 Oslo equals 14:30-15:30 UTC.

select cron.schedule(
  'signal-desk-daily-setup',
  '30 14 * * *',
  $$
  select
    net.http_post(
      url := 'https://drcplgjbrzzfnjbyqcph.supabase.co/functions/v1/daily-setup',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer YOUR_SUPABASE_ANON_KEY',
        'apikey', 'YOUR_SUPABASE_ANON_KEY'
      ),
      body := '{"source":"cron","job":"daily-setup"}'::jsonb
    ) as request_id;
  $$
);

select cron.schedule(
  'signal-desk-monitor-1630-1659',
  '30-59 14 * * *',
  $$
  select
    net.http_post(
      url := 'https://drcplgjbrzzfnjbyqcph.supabase.co/functions/v1/monitor-signals',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer YOUR_SUPABASE_ANON_KEY',
        'apikey', 'YOUR_SUPABASE_ANON_KEY'
      ),
      body := '{"source":"cron","job":"monitor-signals"}'::jsonb
    ) as request_id;
  $$
);

select cron.schedule(
  'signal-desk-monitor-1700-1730',
  '0-30 15 * * *',
  $$
  select
    net.http_post(
      url := 'https://drcplgjbrzzfnjbyqcph.supabase.co/functions/v1/monitor-signals',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer YOUR_SUPABASE_ANON_KEY',
        'apikey', 'YOUR_SUPABASE_ANON_KEY'
      ),
      body := '{"source":"cron","job":"monitor-signals"}'::jsonb
    ) as request_id;
  $$
);

select cron.schedule(
  'signal-desk-recompute-learning',
  '5 * * * *',
  $$
  select
    net.http_post(
      url := 'https://drcplgjbrzzfnjbyqcph.supabase.co/functions/v1/recompute-learning',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer YOUR_SUPABASE_ANON_KEY',
        'apikey', 'YOUR_SUPABASE_ANON_KEY'
      ),
      body := '{"source":"cron","job":"recompute-learning"}'::jsonb
    ) as request_id;
  $$
);

select cron.schedule(
  'signal-desk-resolve-trades',
  '*/15 * * * *',
  $$
  select
    net.http_post(
      url := 'https://drcplgjbrzzfnjbyqcph.supabase.co/functions/v1/resolve-trades',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer YOUR_SUPABASE_ANON_KEY',
        'apikey', 'YOUR_SUPABASE_ANON_KEY'
      ),
      body := '{"source":"cron","job":"resolve-trades"}'::jsonb
    ) as request_id;
  $$
);
