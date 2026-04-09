create extension if not exists pgcrypto;

create table if not exists market_setups (
  id uuid primary key default gen_random_uuid(),
  trade_date date not null,
  market text not null check (market in ('SOL', 'EURUSD')),
  bias text not null check (bias in ('long', 'short')),
  confidence integer not null check (confidence >= 0 and confidence <= 100),
  recommendation text not null check (
    recommendation in ('not_recommended', 'weak', 'moderate', 'strong')
  ),
  entry_zone text not null,
  trigger_type text not null check (
    trigger_type in (
      'bullish_engulfing',
      'bearish_engulfing',
      'shooting_star',
      'hammer',
      'breakout_retest',
      'momentum_close'
    )
  ),
  trigger_note text not null,
  monitor_state text not null default 'waiting' check (
    monitor_state in ('waiting', 'watching', 'confirmed')
  ),
  monitor_message text not null,
  generated_at timestamptz not null,
  data_source text not null,
  features jsonb not null default '{}'::jsonb
);

create table if not exists trades (
  id uuid primary key default gen_random_uuid(),
  setup_id uuid references market_setups(id),
  trade_date date not null,
  market text not null check (market in ('SOL', 'EURUSD')),
  bias text not null check (bias in ('long', 'short')),
  confidence integer not null check (confidence >= 0 and confidence <= 100),
  recommendation text not null check (
    recommendation in ('not_recommended', 'weak', 'moderate', 'strong')
  ),
  entry_zone text not null,
  trigger_type text not null check (
    trigger_type in (
      'bullish_engulfing',
      'bearish_engulfing',
      'shooting_star',
      'hammer',
      'breakout_retest',
      'momentum_close'
    )
  ),
  trigger_note text not null,
  status text not null default 'open' check (status in ('open', 'closed')),
  result text check (result in ('win', 'loss')),
  entry_confirmed_at timestamptz not null,
  closed_at timestamptz,
  data_source text not null,
  features jsonb not null default '{}'::jsonb,
  learning_snapshot jsonb not null default '{}'::jsonb
);

create table if not exists learning_state (
  market text primary key check (market in ('SOL', 'EURUSD')),
  sample_size integer not null default 0,
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists app_settings (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table market_setups alter column id set default gen_random_uuid();
alter table trades alter column id set default gen_random_uuid();
alter table trades add column if not exists setup_id uuid references market_setups(id);

insert into app_settings (key, value)
values
  ('watch_window', '{"start":"16:30","end":"17:30","timezone":"Europe/Oslo","pollSeconds":45}'),
  ('notification_email', '{"email":"dinorebac@gmail.com"}'),
  ('learning_window', '{"count":100}'),
  ('auto_resolution', '{"interval":"15m","logic":"hidden_atr_exit","notes":"Resolves win/loss automatically from post-entry candles"}')
on conflict (key) do nothing;

insert into learning_state (market, sample_size, state)
values
  ('SOL', 0, '{"mode":"Warmup","overallWinRate":0,"biasWeights":{"long":0.5,"short":0.5},"triggerWeights":{"bullish_engulfing":0.5,"bearish_engulfing":0.5,"shooting_star":0.5,"hammer":0.5,"breakout_retest":0.5,"momentum_close":0.5}}'),
  ('EURUSD', 0, '{"mode":"Warmup","overallWinRate":0,"biasWeights":{"long":0.5,"short":0.5},"triggerWeights":{"bullish_engulfing":0.5,"bearish_engulfing":0.5,"shooting_star":0.5,"hammer":0.5,"breakout_retest":0.5,"momentum_close":0.5}}')
on conflict (market) do nothing;

with ranked_market_setups as (
  select
    ctid,
    row_number() over (
      partition by trade_date, market
      order by generated_at desc, id desc
    ) as rn
  from market_setups
)
delete from market_setups
where ctid in (
  select ctid
  from ranked_market_setups
  where rn > 1
);

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'trades'
      and column_name = 'setup_id'
  ) then
    delete from trades
    where ctid in (
      with ranked_trades as (
        select
          ctid,
          row_number() over (
            partition by setup_id
            order by entry_confirmed_at desc, id desc
          ) as rn
        from trades
        where setup_id is not null
      )
      select ctid
      from ranked_trades
      where rn > 1
    );
  end if;
end $$;

create index if not exists idx_market_setups_trade_date on market_setups (trade_date desc, market);
create unique index if not exists uq_market_setups_trade_date_market on market_setups (trade_date, market);
create index if not exists idx_trades_trade_date on trades (trade_date desc, market);
create index if not exists idx_trades_status on trades (status, result);
create unique index if not exists uq_trades_setup_id on trades (setup_id) where setup_id is not null;
