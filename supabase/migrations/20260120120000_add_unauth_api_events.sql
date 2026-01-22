-- Unauthenticated API events (for System Reports)
-- Stores API success/error messages when we can't attribute an authenticated caller (no actor_user_id).

create extension if not exists pgcrypto;

create table if not exists public.unauth_api_events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),

  outcome text not null check (outcome in ('success', 'error')),
  status integer not null,
  method text not null,
  path text not null,
  query text not null default '',

  ip text null,
  user_agent text null,

  code text null,
  public_message text not null,
  internal_message text null,
  details jsonb null
);

create index if not exists unauth_api_events_created_at_idx on public.unauth_api_events (created_at desc);
create index if not exists unauth_api_events_path_idx on public.unauth_api_events (path);

alter table public.unauth_api_events enable row level security;

