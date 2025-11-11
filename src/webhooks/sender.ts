import crypto from 'node:crypto';
import { sql } from '../db.js';

const WEBHOOK_URL = process.env.WEBHOOK_URL || '';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';

function sign(body: any) {
  if (!WEBHOOK_SECRET) return '';
  const payload = JSON.stringify(body);
  return crypto.createHmac('sha256', WEBHOOK_SECRET).update(payload).digest('hex');
}

export async function queueWebhook(event: string, data: any) {
  if (!WEBHOOK_URL) return;
  const body = { event, data, ts: Date.now() };
  const signature = sign(body);
  await sql/*sql*/`
    insert into webhook_outbox (event, payload, signature)
    values (${event}, ${sql.json(body)}, ${signature || null})
  `;
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
function backoff(attempt: number) { const base = 1500; return Math.min(60000, base * Math.pow(2, attempt)); }

export async function startOutboxWorker() {
  if (!WEBHOOK_URL) return;
  (async () => {
    for (;;) {
      const jobs = await sql/*sql*/`
        update webhook_outbox
        set status = 'processing'
        where id in (
          select id from webhook_outbox
          where status = 'pending' and next_attempt <= now()
          order by id asc
          limit 1
          for update skip locked
        )
        returning id, attempts, payload, signature
      `;
      if (jobs.length === 0) { await sleep(1000); continue; }
      const job = jobs[0] as any;
      try {
        const res = await fetch(WEBHOOK_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(job.signature ? { 'x-signature-sha256': job.signature } : {}) },
          body: JSON.stringify(job.payload)
        });
        if (!res.ok) throw new Error('http_' + res.status);
        await sql/*sql*/`update webhook_outbox set status='ok' where id=${job.id}`;
      } catch (e) {
        const next = backoff(job.attempts || 0);
        const dead = (job.attempts || 0) + 1 >= 6;
        await sql/*sql*/`
          update webhook_outbox
          set attempts = attempts + 1,
              status = ${dead ? 'dead' : 'pending'},
              next_attempt = now() + interval '${next/1000} seconds'
          where id=${job.id}
        `;
      }
    }
  })().catch(() => {});
}
