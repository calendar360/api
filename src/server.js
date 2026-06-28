import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import userRouter from './routes/userRoute.js';
import oauthRouter from './routes/oauthRoute.js';
import eventsRouter from './routes/eventsRoute.js';
import uploadRouter from './routes/uploadRoute.js';
import wordsRouter from './routes/wordsRoute.js';
import adsRouter from './routes/adsRoute.js';
import paymentsRouter from './routes/paymentsRoute.js';
import appSettingsRouter from './routes/appSettingsRoute.js';
import themesRouter from './routes/themesRoute.js';
import onThisDayRouter from './routes/onThisDayRoute.js';
import { initFcm } from './services/fcmService.js';
import { notFoundHandler, errorHandler } from './middleware/errorHandler.js';
import { ensureSchema } from './db/ensureSchema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadsDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;
const HOST = process.env.HOST || '0.0.0.0';

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

app.get('/health', async (_req, res) => {
  let database = 'disconnected';
  try {
    const { default: pool } = await import('./db/pool.js');
    await pool.query('SELECT 1');
    database = 'connected';
  } catch (err) {
    database = `error: ${err.message}`;
  }
  res.json({
    success: true,
    message: 'Calendar 360 API is running',
    port: PORT,
    database,
    oauthCallback: `http://localhost:${PORT}/oauth/callback`,
  });
});

app.get('/', (_req, res) => {
  res.json({
    success: true,
    message: 'Calendar 360 API',
    endpoints: {
      health: '/health',
      kingschatLogin: 'POST /api/user/kingschat',
      me: 'GET /api/user/me',
      oauthCallback: '/oauth/callback',
    },
  });
});

app.use('/uploads', express.static(uploadsDir));
app.use('/oauth', oauthRouter);
app.use('/api/user', userRouter);
app.use('/api/events', eventsRouter);
app.use('/api/upload', uploadRouter);
app.use('/api/words', wordsRouter);
app.use('/api/ads', adsRouter);
app.use('/api/payments', paymentsRouter);
app.use('/api/app-settings', appSettingsRouter);
app.use('/api/themes', themesRouter);
app.use('/api/on-this-day', onThisDayRouter);

app.use(notFoundHandler);
app.use(errorHandler);

async function start() {
  try {
    await ensureSchema();
    await initFcm();
  } catch (err) {
    console.error('[db] schema init failed:', err.message);
    console.error('[db] check DATABASE_URL in api/.env');
  }

  app.listen(PORT, HOST, () => {
    console.log(`API server running on http://${HOST}:${PORT}`);
    console.log(`OAuth callback: http://10.0.2.2:${PORT}/oauth/callback (Android emulator)`);
    console.log(`OAuth callback: http://localhost:${PORT}/oauth/callback (iOS simulator)`);
  });
}

start();
