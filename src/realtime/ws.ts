import { WebSocketServer, WebSocket } from 'ws';
type Client = WebSocket & { subs?: Set<string> };
const channels = new Map<string, Set<Client>>();
export function makeWSS(server: any) {
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws: Client) => {
    ws.subs = new Set();
    ws.on('message', (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'sub' && typeof msg.channel === 'string') {
          const set = channels.get(msg.channel) ?? new Set<Client>();
          set.add(ws); channels.set(msg.channel, set); ws.subs!.add(msg.channel);
        }
      } catch {}
    });
    ws.on('close', () => ws.subs?.forEach(ch => channels.get(ch)?.delete(ws)));
  });
  function publish(channel: string, payload: any) {
    const set = channels.get(channel);
    if (!set) return;
    const data = JSON.stringify({ channel, data: payload });
    for (const c of set) try { c.send(data); } catch {}
  }
  return { publish };
}
