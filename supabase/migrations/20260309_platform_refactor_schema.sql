create table if not exists uploaded_assets (
  id text primary key,
  conversation_id text not null references chat_rooms(id) on delete cascade,
  file_name text not null,
  media_type text not null,
  size bigint not null default 0,
  url text,
  created_at timestamptz not null default now()
);

create index if not exists idx_uploaded_assets_conversation_created
  on uploaded_assets (conversation_id, created_at desc);

create table if not exists capability_runs (
  id text primary key,
  capability_key text not null,
  conversation_id text,
  input_envelope jsonb,
  output_envelope jsonb,
  status text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_capability_runs_created
  on capability_runs (created_at desc);
