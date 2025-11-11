import { Router } from 'express';
import type { EventEmitter } from 'node:events';
import { WaGateway, MediaType } from './gateway.js';
import QRCode from 'qrcode';
import { append, ensureSession } from '../inbox/store.js';
import { queueWebhook } from '../webhooks/sender.js';

export function waRoutes(gw: WaGateway, bus: EventEmitter, publish: (ch:string, p:any)=>void) {
  const r = Router();

  r.post('/sessions/:id/start', async (req, res) => {
    const { id } = req.params;
    try { await ensureSession(id); await gw.start(id); res.json({ ok: true }); }
    catch (err: any) { res.status(500).json({ error: err?.message ?? 'start_failed' }); }
  });

  r.get('/sessions/:id/qr.png', async (req, res) => {
    const { id } = req.params;
    let lastQR: string | null = null;
    const listener = (evt: any) => { if (evt.sessionId === id && evt.qr) lastQR = evt.qr; };
    bus.on('session:qr', listener);
    await new Promise(r => setTimeout(r, 250));
    bus.off('session:qr', listener);
    if (!lastQR) return res.status(404).json({ error: 'no_qr_available' });
    res.setHeader('Content-Type', 'image/png');
    QRCode.toFileStream(res, lastQR, { type: 'png' });
  });

  r.get('/sessions/:id/status', (req, res) => {
    try { gw.get(req.params.id); res.json({ ready: true }); } catch { res.json({ ready: false }); }
  });

  r.post('/sessions/:id/messages/text', async (req, res) => {
    const { id } = req.params; const { to, text } = req.body as { to: string; text: string };
    try {
      const jid = formatJid(to);
      await gw.sendText(id, jid, text);
      const msg = { message: { conversation: text } };
      const newId = await append(id, { jid, direction: 'out', type: 'text', message: msg });
      queueWebhook('message.out', { sessionId: id, jid, id: newId, message: msg }).catch(()=>{});
      res.json({ ok: true, id: newId });
    }
    catch (err: any) { res.status(500).json({ error: err?.message ?? 'send_failed' }); }
  });

  r.post('/sessions/:id/messages/media', async (req, res) => {
    const { id } = req.params;
    const { to, type, url, base64, caption, filename, mimetype } = req.body as any;
    try {
      const jid = formatJid(to);
      await gw.sendMedia(id, jid, type as MediaType, { url, base64, caption, filename, mimetype });
      const msg = { message: { [type+'Message']: { caption, mimetype, fileName: filename } } };
      const newId = await append(id, { jid, direction: 'out', type, message: msg });
      queueWebhook('message.out', { sessionId: id, jid, id: newId, message: msg }).catch(()=>{});
      res.json({ ok: true, id: newId });
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? 'media_failed' });
    }
  });

  bus.on('wa:inbound', async ({ sessionId, message }: any) => {
    const jid = message.key?.remoteJid;
    const rec = { ts: Date.now(), jid, direction: 'in' as const, type: Object.keys(message.message || {})[0] || 'unknown', message };
    try { const id = await append(sessionId, rec); publish(`session:${sessionId}:contact:${jid}`, { type: 'message', direction: 'in', message, id }); queueWebhook('message.in', { sessionId, jid, id, message }).catch(()=>{}); } catch {}
  });
  bus.on('session:ready', ({ sessionId }: any) => { queueWebhook('session.ready', { sessionId }).catch(()=>{}); });

  return r;
}

function formatJid(phone: string) {
  const digits = phone.replace(/\D/g, '');
  if (!digits.endsWith('@s.whatsapp.net')) return `${digits}@s.whatsapp.net`;
  return digits;
}
