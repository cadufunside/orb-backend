import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, WASocket, downloadContentFromMessage } from 'baileys';
import Pino from 'pino';
import fs from 'node:fs';
import path from 'node:path';
import type { EventEmitter } from 'node:events';

export type MediaType = 'image' | 'audio' | 'video' | 'document';
type Session = { id: string; sock: WASocket; isReady: boolean; };

export class WaGateway {
  private sessions = new Map<string, Session>();
  constructor(private sessionDir: string, private bus: EventEmitter) {}
  async start(sessionId: string) {
    const base = path.resolve(this.sessionDir, sessionId);
    fs.mkdirSync(base, { recursive: true });
    const logger = Pino({ level: 'info' });
    const { state, saveCreds } = await useMultiFileAuthState(base);
    const { version } = await fetchLatestBaileysVersion();
    const sock = makeWASocket({ auth: state, logger, version, printQRInTerminal: false });
    sock.ev.on('connection.update', (update) => {
      const { qr, connection, lastDisconnect } = update as any;
      if (qr) this.bus.emit('session:qr', { sessionId, qr });
      if (connection === 'open') this.bus.emit('session:ready', { sessionId });
      if (connection === 'close') {
        const code = (lastDisconnect as any)?.error?.output?.statusCode;
        if (code !== DisconnectReason.loggedOut) setTimeout(() => this.start(sessionId), 1000);
        else this.bus.emit('session:logout', { sessionId });
      }
    });
    sock.ev.on('messages.upsert', (upsert) => {
      const msgs = (upsert as any).messages || [];
      for (const m of msgs) this.bus.emit('wa:inbound', { sessionId, message: m });
    });
    sock.ev.on('creds.update', saveCreds);
    const session: Session = { id: sessionId, sock, isReady: true };
    this.sessions.set(sessionId, session);
    return session;
  }
  get(sessionId: string) { const s = this.sessions.get(sessionId); if (!s) throw new Error('session_not_found'); return s; }
  async sendText(sessionId: string, jid: string, text: string) { const s = this.get(sessionId); await s.sock.sendMessage(jid, { text }); }
  async sendMedia(sessionId: string, jid: string, type: MediaType, data: { url?: string; base64?: string; caption?: string; filename?: string; mimetype?: string; }) {
    const s = this.get(sessionId);
    const streamFromUrl = async (url: string) => { const res = await fetch(url); if (!res.ok) throw new Error(`fetch_${res.status}`); return Buffer.from(await res.arrayBuffer()); };
    let buffer: Buffer | null = null;
    if (data.base64) buffer = Buffer.from(data.base64, 'base64');
    if (!buffer && data.url) buffer = await streamFromUrl(data.url);
    if (!buffer) throw new Error('no_media_data');
    const msg: any = {}; const common: any = { caption: data.caption };
    if (type === 'image') msg.image = buffer;
    if (type === 'video') msg.video = buffer;
    if (type === 'audio') msg.audio = buffer;
    if (type === 'document') { msg.document = buffer; if (data.filename) common.fileName = data.filename; }
    Object.assign(msg, common); if (data.mimetype) msg.mimetype = data.mimetype;
    await s.sock.sendMessage(jid, msg);
  }
  async downloadMediaToFile(message: any, destPath: string) {
    const types = ['imageMessage','videoMessage','audioMessage','documentMessage'] as const;
    const found = types.find(t => message?.message?.[t]);
    if (!found) throw new Error('no_media');
    const msgNode: any = message.message[found];
    const stream = await downloadContentFromMessage(msgNode, found.replace('Message','') as any);
    const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);
    require('node:fs').writeFileSync(destPath, buffer);
    return destPath;
  }
}
