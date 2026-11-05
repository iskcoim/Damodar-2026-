-- Run once in Supabase → SQL Editor, before the Srila Prabhupada pages go live.
-- Row level security with no policies: only the server's secret key can read or write these.

create table if not exists public.prabhupada_offerings (
  id bigint generated always as identity primary key,
  festival text not null,
  name text not null,
  phone text not null,
  email text,
  place text,
  offering_type text not null default 'text',
  offering text,
  file_path text,
  file_name text,
  link text,
  may_share boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.prabhupada_donations (
  id bigint generated always as identity primary key,
  festival text not null,
  seva text not null,
  name text not null,
  phone text not null,
  email text,
  amount integer not null check (amount > 0),
  reference text not null unique,
  created_at timestamptz not null default now()
);

alter table public.prabhupada_offerings enable row level security;
alter table public.prabhupada_donations enable row level security;

-- Private storage for audio, video and scanned offerings (50 MB per file)
insert into storage.buckets (id, name, public, file_size_limit)
values ('prabhupada-offerings', 'prabhupada-offerings', false, 52428800)
on conflict (id) do nothing;

-- To accept videos up to 500 MB, after upgrading to the Pro plan:
--   1. In Supabase, go to Storage → Settings and raise the global file size limit to 500 MB.
--   2. Run this line:
--        update storage.buckets set file_size_limit = 524288000 where id = 'prabhupada-offerings';
--   3. In Vercel, set PRABHUPADA_MAX_VIDEO_MB to 500, then redeploy.
