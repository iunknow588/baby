create table if not exists chat_rooms (
  id text primary key,
  name text not null,
  type text not null,
  last_active_at timestamptz not null default now()
);

create table if not exists chat_room_members (
  room_id text not null references chat_rooms(id) on delete cascade,
  user_id text not null,
  joined_at timestamptz not null default now(),
  primary key (room_id, user_id)
);

create table if not exists chat_messages (
  id text primary key,
  room_id text not null references chat_rooms(id) on delete cascade,
  sender_id text not null,
  sender_type text not null,
  message_type text not null,
  content text not null,
  status text not null default 'delivered',
  meta jsonb,
  files jsonb,
  created_at timestamptz not null default now()
);

create table if not exists coze_conversations (
  room_id text not null references chat_rooms(id) on delete cascade,
  agent_id text not null,
  conversation_id text not null,
  updated_at timestamptz not null default now(),
  primary key (room_id, agent_id)
);

create index if not exists idx_chat_messages_room_created_at
  on chat_messages (room_id, created_at desc);

create index if not exists idx_chat_room_members_user
  on chat_room_members (user_id);
