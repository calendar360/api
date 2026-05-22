import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pool from '../db/pool.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let messaging = null;
let initAttempted = false;

function resolveServiceAccountPath() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    return path.resolve(process.env.FIREBASE_SERVICE_ACCOUNT);
  }
  const candidates = [
    path.join(__dirname, '../../calendar-360-firebase-adminsdk-fbsvc-85d7dbb4d0.json'),
    path.join(__dirname, '../../../android/calendar-360-firebase-adminsdk-fbsvc-85d7dbb4d0.json'),
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

export async function initFcm() {
  if (initAttempted) return messaging != null;
  initAttempted = true;

  const saPath = resolveServiceAccountPath();
  if (!saPath) {
    console.warn('[fcm] No service account JSON. Set FIREBASE_SERVICE_ACCOUNT in api/.env');
    return false;
  }

  try {
    const admin = (await import('firebase-admin')).default;
    if (!admin.apps.length) {
      const serviceAccount = JSON.parse(fs.readFileSync(saPath, 'utf8'));
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    }
    messaging = admin.messaging();
    console.log('[fcm] Firebase Admin ready');
    return true;
  } catch (e) {
    console.error('[fcm] init failed:', e.message);
    return false;
  }
}

export const GLOBAL_EVENTS_TOPIC = 'global_events';

/** Notify all devices subscribed to global_events topic. */
export async function pushGlobalEvent({ title, body, eventId }) {
  const ok = await initFcm();
  if (!ok || !messaging) return { sent: false, reason: 'fcm_not_configured' };

  try {
    const messageId = await messaging.send({
      topic: GLOBAL_EVENTS_TOPIC,
      notification: { title, body },
      data: {
        type: 'global_event',
        eventId: eventId || '',
      },
      android: {
        priority: 'high',
        notification: {
          channelId: 'global_admin_events',
          priority: 'high',
          defaultSound: true,
        },
      },
      apns: {
        payload: {
          aps: {
            alert: { title, body },
            sound: 'default',
          },
        },
      },
    });
    console.log('[fcm] topic push sent:', messageId);
    return { sent: true, messageId };
  } catch (e) {
    console.error('[fcm] push failed:', e.message);
    return { sent: false, reason: e.message };
  }
}

export async function saveUserFcmToken(userId, token) {
  if (!userId || !token) return;
  await pool.query(
    `UPDATE users SET fcm_token = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
    [token, userId],
  );
}
