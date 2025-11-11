import postgres from 'postgres';
const url = process.env.DATABASE_URL || '';
if (!url) { console.warn('[db] DATABASE_URL ausente'); }
export const sql = postgres(url, { ssl: url.includes('sslmode=require') ? 'require' : undefined, max: 5, idle_timeout: 10 });
export async function initSchema() {
  await sql/*sql*/`
  create table if not exists sessions ( id text primary key, created_at timestamptz default now() );
  create table if not exists inbox_messages (
    id bigserial primary key,
    ts timestamptz not null default now(),
    session_id text not null references sessions(id) on delete cascade,
    jid text not null,
    direction text not null check (direction in ('in','out')),
    type text not null,
    message jsonb not null
  );
  create index if not exists idx_inbox_session_jid_ts on inbox_messages(session_id, jid, ts desc);
  create index if not exists idx_inbox_session_ts on inbox_messages(session_id, ts desc);
  create table if not exists thread_state ( session_id text not null, jid text not null, last_read_id bigint not null default 0, primary key (session_id, jid) );
  create table if not exists webhook_outbox ( id bigserial primary key, created_at timestamptz default now(), status text not null default 'pending', attempts int not null default 0, next_attempt timestamptz default now(), event text not null, payload jsonb not null, signature text );
  `;
}

  create table if not exists thread_state (
    session_id text not null,
    jid text not null,
    last_read_id bigint not null default 0,
    primary key (session_id, jid)
  );

  create table if not exists webhook_outbox (
    id bigserial primary key,
    created_at timestamptz default now(),
    status text not null default 'pending',
    attempts int not null default 0,
    next_attempt timestamptz default now(),
    event text not null,
    payload jsonb not null,
    signature text
  );`;
}
