import { Router } from 'express';
import type { EventEmitter } from 'node:events';
import { WaGateway } from './gateway';
import QRCode from 'qrcode';

export function waRoutes(gw: WaGateway, bus: EventEmitter, publish: (ch:string, p:any)=>void) {
  const r = Router();

  r.post('/sessions/:id/start', async (req, res) => {
    const { id } = req.params;
    try {
      await gw.start(id);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? 'start_failed' });
    }
  });

  r.get('/sessions/:id/qr.png', async (req, res) => {
    const { id } = req.params;
    let lastQR: string | null = null;

    const listener = (evt: any) => { if (evt.sessionId === id && evt.qr) lastQR = evt.qr; };
    bus.on('session:qr', listener);

    await new Promise((resolve) => setTimeout(resolve, 250));
    bus.off('session:qr', listener);

    if (!lastQR) return res.status(404).json({ error: 'no_qr_available' });
    res.setHeader('Content-Type', 'image/png');
    QRCode.toFileStream(res, lastQR, { type: 'png' });
  });

  r.post('/sessions/:id/messages/text', async (req, res) => {
    const { id } = req.params;
    const { to, text } = req.body as { to: string; text: string };
    try {
      const s = gw.get(id);
      const jid = formatJid(to);
      await s.sendText(jid, text);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? 'send_failed' });
    }
  });

  r.get('/sessions/:id/status', (req, res) => {
    try {
      gw.get(req.params.id);
      res.json({ ready: true });
    } catch {
      res.json({ ready: false });
    }
  });

  bus.on('wa:inbound', ({ sessionId, message }: any) => {
    const jid = message.key?.remoteJid;
    publish(`session:${sessionId}:contact:${jid}`, {
      type: 'message',
      direction: 'in',
      message
    });
  });

  bus.on('session:ready', ({ sessionId }: any) => publish(`session:${sessionId}:events`, { type: 'ready' }));

  return r;
}

function formatJid(phone: string) {
  const digits = phone.replace(/\D/g, '');
  if (!digits.endsWith('@s.whatsapp.net')) return `${digits}@s.whatsapp.net`;
  return digits;
}
