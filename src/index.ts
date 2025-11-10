import express from 'express';
import http from 'http';
import cors from 'cors';
import { EventEmitter } from 'node:events';
import { env } from './config';
import { makeWSS } from './realtime/ws';
import { WaGateway } from './wa/gateway';
import { waRoutes } from './wa/routes';

const app = express();
if (env.TRUST_PROXY) app.set('trust proxy', true);
app.use(cors({ origin: env.DASHBOARD_ORIGIN === '*' ? true : env.DASHBOARD_ORIGIN }));
app.use(express.json({ limit: '5mb' }));

const server = http.createServer(app);
const ws = makeWSS(server);
const bus = new EventEmitter();
const gw = new WaGateway(env.SESSION_DIR, bus);

app.use('/api', waRoutes(gw, bus, ws.publish));
app.get('/healthz', (_, res) => res.json({ ok: true }));
server.listen(env.PORT, () => console.log(`[orb-backend] listening on :${env.PORT}`));
