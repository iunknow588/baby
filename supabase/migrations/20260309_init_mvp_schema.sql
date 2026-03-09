create extension if not exists pgcrypto;

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  device_id text unique not null,
  created_at timestamptz not null default now(),
  last_active timestamptz not null default now()
);

create index if not exists idx_users_device_id on users(device_id);

create table if not exists conversations (
  id bigserial primary key,
  user_id uuid not null references users(id) on delete cascade,
  question text not null,
  answer text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_conversations_user on conversations(user_id);
create index if not exists idx_conversations_created on conversations(created_at desc);
