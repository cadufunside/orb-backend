import { sql } from '../db.js';

export async function ensureSession(sessionId: string) {
  await sql/*sql*/`
    insert into sessions (id) values (${sessionId})
    on conflict (id) do nothing
  `;
}

export async function append(sessionId: string, rec: { ts?: number; jid: string; direction:'in'|'out'; type:string; message:any; }) {
  await ensureSession(sessionId);
  const rows = await sql/*sql*/`
    insert into inbox_messages (session_id, jid, direction, type, message, ts)
    values (${sessionId}, ${rec.jid}, ${rec.direction}, ${rec.type}, ${sql.json(rec.message)}, to_timestamp(${(rec.ts ?? Date.now())/1000.0}))
    returning id
  `;
  const id = (rows[0] as any).id as number;
  return id;
}

export async function history(sessionId: string, jid: string, limit = 100, beforeId?: number) {
  const rows = await sql/*sql*/`
    select id, extract(epoch from ts)*1000 as ts, session_id, jid, direction, type, message
    from inbox_messages
    where session_id = ${sessionId} and jid = ${jid}
      ${ beforeId ? sql`and id < ${beforeId}` : sql`` }
    order by id desc
    limit ${limit}
  `;
  return rows;
}

export async function markRead(sessionId: string, jid: string, lastReadId: number) {
  await sql/*sql*/`
    insert into thread_state (session_id, jid, last_read_id)
    values (${sessionId}, ${jid}, ${lastReadId})
    on conflict (session_id, jid) do update set last_read_id = greatest(thread_state.last_read_id, excluded.last_read_id)
  `;
}

export async function getThreadSummary(sessionId: string, jid: string) {
  const last = await sql/*sql*/`
    select id, extract(epoch from ts)*1000 as ts, direction, type,
      (message->'message'->>'conversation') as preview_text
    from inbox_messages
    where session_id=${sessionId} and jid=${jid}
    order by id desc
    limit 1
  `;
  const state = await sql/*sql*/`select last_read_id from thread_state where session_id=${sessionId} and jid=${jid}`;
  const last_read_id = (state[0] && (state[0] as any).last_read_id) || 0;
  const unread = await sql/*sql*/`
    select count(*)::int as c from inbox_messages
    where session_id=${sessionId} and jid=${jid} and direction='in' and id > ${last_read_id}
  `;
  return {
    jid,
    last_message: last[0] || null,
    unread_count: (unread[0] as any)?.c ?? 0,
    last_read_id
  };
}

export async function listThreads(sessionId: string, limit = 20, beforeTs?: number) {
  const rows = await sql/*sql*/`
    with last_per_jid as (
      select distinct on (jid)
        jid, id, ts, direction, type,
        (message->'message'->>'conversation') as preview_text
      from inbox_messages
      where session_id=${sessionId}
        ${ beforeTs ? sql`and ts < to_timestamp(${beforeTs/1000.0})` : sql`` }
      order by jid, ts desc
    )
    select lpj.jid,
           extract(epoch from lpj.ts)*1000 as last_ts,
           lpj.id as last_id,
           lpj.direction as last_direction,
           lpj.type as last_type,
           lpj.preview_text as last_preview,
           coalesce(ts.last_read_id, 0) as last_read_id,
           (select count(*)::int from inbox_messages im
             where im.session_id=${sessionId} and im.jid=lpj.jid and im.direction='in' and im.id > coalesce(ts.last_read_id,0)
           ) as unread_count
    from last_per_jid lpj
    left join thread_state ts on ts.session_id=${sessionId} and ts.jid=lpj.jid
    order by last_ts desc
    limit ${limit}
  `;
  return rows;
}
