import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pool from '../db/pool.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let messaging = null;

function resolveServiceAccountPath() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    return path.resolve(process.env.FIREBASE_SERVICE_ACCOUNT);
  }
  const candidates = [
    path.join(__dirname, '../../calendar-360-60316-firebase-adminsdk-fbsvc-a7c8c33bda.json'),
    path.join(__dirname, '../../../android/calendar-360-60316-firebase-adminsdk-fbsvc-a7c8c33bda.json'),
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

export async function initFcm() {
  if (messaging) return true;

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
export async function pushGlobalEvent({ title, body, eventId, extraData }) {
  const ok = await initFcm();
  if (!ok || !messaging) return { sent: false, reason: 'fcm_not_configured' };

  try {
    const messageId = await messaging.send({
      topic: GLOBAL_EVENTS_TOPIC,
      notification: { title, body },
      // FCM rejects the whole message if any data value is not a string,
      // so coerce here rather than trusting every call site.
      data: Object.fromEntries(
        Object.entries({
          type: 'global_event',
          eventId: eventId || '',
          ...(extraData || {}),
        }).map(([k, v]) => [k, String(v ?? '')]),
      ),
      android: {
        priority: 'high',
        notification: {
          // Matches ReminderService.globalChannel in the Flutter app (also
          // the manifest's default_notification_channel_id fallback) so
          // delivery doesn't depend on undocumented OS fallback behavior.
          channelId: 'cal360_global_events_v2',
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
    console.log('[fcm] topic push sent:', messageId, '| title:', title);
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

/** Send a push notification to a specific device token. */
export async function pushToUser(fcmToken, { title, body, data = {} }) {
  if (!fcmToken) return { sent: false, reason: 'no_token' };
  const ok = await initFcm();
  if (!ok || !messaging) return { sent: false, reason: 'fcm_not_configured' };
  try {
    const messageId = await messaging.send({
      token: fcmToken,
      notification: { title, body },
      data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
      android: {
        priority: 'high',
        notification: { channelId: 'cal360_reminders_v2', priority: 'high', defaultSound: true },
      },
      apns: {
        payload: { aps: { alert: { title, body }, sound: 'default' } },
      },
    });
    return { sent: true, messageId };
  } catch (e) {
    console.error('[fcm] pushToUser failed:', e.message);
    return { sent: false, reason: e.message };
  }
}

/**
 * Sends to one user, looked up by id.
 *
 * Saves every call site from having to select fcm_token itself, and reports a
 * missing token as a reason rather than an error — a user who has never
 * granted notifications is a normal case, not a failure.
 */
export async function pushToUserId(userId, { title, body, data = {} }) {
  if (!userId) return { sent: false, reason: 'no_user' };
  try {
    const { rows } = await pool.query(
      'SELECT fcm_token FROM users WHERE id = $1',
      [userId],
    );
    const token = rows[0]?.fcm_token;
    if (!token) return { sent: false, reason: 'no_token' };
    return await pushToUser(token, { title, body, data });
  } catch (e) {
    console.error('[fcm] pushToUserId failed:', e.message);
    return { sent: false, reason: e.message };
  }
}

/**
 * Sends to every admin that has a device token.
 *
 * Used for work that needs a human decision — an advert waiting for approval.
 * Sent per token rather than over a topic, because admin is a database flag
 * that can be granted or revoked at any time, and a topic subscription made
 * at install time could not follow that.
 */
export async function pushToAdmins({ title, body, data = {} }) {
  try {
    const { rows } = await pool.query(
      `SELECT id, fcm_token FROM users
        WHERE is_admin = true AND fcm_token IS NOT NULL AND fcm_token <> ''`,
    );
    if (!rows.length) return { sent: false, reason: 'no_admin_tokens', count: 0 };

    const results = await Promise.all(
      rows.map((r) => pushToUser(r.fcm_token, { title, body, data })),
    );
    const sent = results.filter((r) => r.sent).length;
    console.log(`[fcm] admin push "${title}" -> ${sent}/${rows.length} delivered`);
    return { sent: sent > 0, count: sent, attempted: rows.length };
  } catch (e) {
    console.error('[fcm] pushToAdmins failed:', e.message);
    return { sent: false, reason: e.message, count: 0 };
  }
}
