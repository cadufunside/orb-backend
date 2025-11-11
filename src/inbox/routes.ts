import { Router } from 'express';
import { history, markRead, getThreadSummary, listThreads } from './store.js';

export function inboxRoutes() {
  const r = Router();

  r.get('/sessions/:id/threads', async (req, res) => {
    const { id } = req.params;
    const limit = Math.min(Number(req.query.limit || 20), 100);
    const beforeTs = req.query.before_ts ? Number(req.query.before_ts) : undefined;
    try {
      const rows = await listThreads(id, limit, beforeTs);
      res.json({ items: rows, next_before_ts: rows.length ? rows[rows.length - 1].last_ts : null });
    } catch (e:any) { res.status(500).json({ error: e?.message || 'threads_failed' }); }
  });

  r.get('/sessions/:id/threads/:jid/summary', async (req, res) => {
    const { id, jid } = req.params;
    try {
      const s = await getThreadSummary(id, formatJid(jid));
      res.json(s);
    } catch (e:any) { res.status(500).json({ error: e?.message || 'summary_failed' }); }
  });

  r.get('/sessions/:id/messages/:jid/history', async (req, res) => {
    const { id, jid } = req.params;
    const limit = Math.min(Number(req.query.limit || 50), 200);
    const beforeId = req.query.before_id ? Number(req.query.before_id) : undefined;
    try {
      const rows = await history(id, formatJid(jid), limit, beforeId);
      res.json({ items: rows, next_before_id: rows.length ? rows[rows.length - 1].id : null });
    } catch (e:any) { res.status(500).json({ error: e?.message || 'history_failed' }); }
  });

  r.post('/sessions/:id/threads/:jid/read', async (req, res) => {
    const { id, jid } = req.params;
    const lastReadId = Number((req.body?.last_read_id ?? 0));
    if (!lastReadId) return res.status(400).json({ error: 'last_read_id_required' });
    try {
      await markRead(id, formatJid(jid), lastReadId);
      res.json({ ok: true });
    } catch (e:any) { res.status(500).json({ error: e?.message || 'mark_read_failed' }); }
  });

  return r;
}

function formatJid(phone: string) {
  const digits = phone.replace(/\D/g, '');
  if (!digits.endsWith('@s.whatsapp.net')) return `${digits}@s.whatsapp.net`;
  return digits;
}
