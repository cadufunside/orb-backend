import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  WASocket,
} from 'baileys';
import Pino from 'pino';
import fs from 'node:fs';
import path from 'node:path';
import type { EventEmitter } from 'node:events';

type Session = { id: string; sock: WASocket; sendText: (jid: string, text: string) => Promise<void>; isReady: boolean; };

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
    const session: Session = { id: sessionId, sock, sendText: async (jid, text) => await sock.sendMessage(jid, { text }), isReady: true };
    this.sessions.set(sessionId, session);
    return session;
  }

  get(sessionId: string) {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error('session_not_found');
    return s;
  }

  async logout(sessionId: string) {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    await s.sock.logout();
    this.sessions.delete(sessionId);
  }
}
