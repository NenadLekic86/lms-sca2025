alter table public.public_app_settings
  add column if not exists top_logo_url text,
  add column if not exists top_logo_compact_url text,
  add column if not exists bottom_logo_url text;
