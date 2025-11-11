import express from 'express';
import http from 'http';
import cors from 'cors';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import fs from 'node:fs';
import dotenv from 'dotenv';
dotenv.config();

const PORT = Number(process.env.PORT || 8080);
const TRUST_PROXY = (process.env.TRUST_PROXY || 'false') === 'true';
const ORIGIN = process.env.DASHBOARD_ORIGIN === '*' ? true : (process.env.DASHBOARD_ORIGIN || '*');
const SESSION_DIR = process.env.SESSION_DIR || path.resolve('.sessions');

import { makeWSS } from './realtime/ws.js';
import { WaGateway } from './wa/gateway.js';
import { waRoutes } from './wa/routes.js';
import { initSchema } from './db.js';
import { startOutboxWorker } from './webhooks/sender.js';
import { inboxRoutes } from './inbox/routes.js';

async function main() {
  await initSchema();

  const app = express();
  if (TRUST_PROXY) app.set('trust proxy', true);
  app.use(cors({ origin: ORIGIN }));
  app.use(express.json({ limit: '10mb' }));

  const server = http.createServer(app);
  const ws = makeWSS(server);
  const bus = new EventEmitter();

  fs.mkdirSync(SESSION_DIR, { recursive: true });
  const gw = new WaGateway(SESSION_DIR, bus);

  app.use('/api', waRoutes(gw, bus, ws.publish));
  app.use('/api', inboxRoutes());

  app.get('/healthz', (_, res) => res.json({ ok: true }));

  server.listen(PORT, () => console.log(`[orb-backend] listening on :${PORT}`));

  startOutboxWorker();
}

main().catch((e) => {
  console.error('fatal_startup', e);
  process.exit(1);
});
