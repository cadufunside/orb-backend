import path from 'node:path';
import dotenv from 'dotenv';
dotenv.config();

export const env = {
  PORT: Number(process.env.PORT ?? 8080),
  SESSION_DIR: process.env.SESSION_DIR ?? path.resolve('.sessions'),
  DASHBOARD_ORIGIN: process.env.DASHBOARD_ORIGIN ?? '*',
  TRUST_PROXY: (process.env.TRUST_PROXY ?? 'false') === 'true'
};
