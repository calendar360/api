import pool from '../db/pool.js';
import { pushBroadcast } from '../services/fcmService.js';
import { uploadPublicUrl } from '../utils/publicUrl.js';

const MAX_HISTORY_PAGE = 100;

const MAX_TITLE = 120;
// Android collapses anything much longer than this in the tray, and the rest
// is only visible once expanded. Kept generous but bounded.
const MAX_BODY = 1000;
const MAX_LINK = 500;

/**
 * Turns what an admin typed into a URL safe to hand every device, or returns
 * an error message explaining why it is not one.
 *
 * A bare domain ("helloloveworld.tv") is the normal way to type a link, so it
 * is upgraded to https rather than rejected. Plain http is refused outright:
 * a broadcast reaches every user at once, and a link that can be tampered
 * with in transit is not something to send at that scale.
 */
export function normaliseLink(raw) {
  if (!raw) return { url: undefined };
  if (raw.length > MAX_LINK) {
    return { error: `Keep the link under ${MAX_LINK} characters` };
  }
  // Whitespace inside a URL is always a mistake, and a newline would let one
  // value look like two.
  if (/\s/.test(raw)) return { error: 'The link cannot contain spaces' };

  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return { error: 'That does not look like a valid link' };
  }

  if (parsed.protocol !== 'https:') {
    return {
      error:
        parsed.protocol === 'http:'
          ? 'Use an https:// link — plain http is not allowed in a broadcast'
          : 'Only https:// links can be sent',
    };
  }
  // A host with no dot is either a typo or an internal name no user can reach.
  if (!parsed.hostname.includes('.')) {
    return { error: 'That does not look like a valid link' };
  }

  return { url: parsed.toString() };
}

/**
 * POST /api/broadcast — admin-only push to every device on the global topic.
 *
 * Takes `{ title, body, image?, link? }`. `image` is the bare filename
 * returned by POST /api/upload — the URL is built here rather than trusted
 * from the client, so a broadcast cannot make every device fetch an arbitrary
 * third-party URL.
 *
 * `link` is different: it is meant to point off-site, so it is validated and
 * normalised rather than rebuilt. It travels in the data payload, not in the
 * visible text, and the app opens it when the notification is tapped.
 */
export const sendBroadcast = async (req, res) => {
  const title = String(req.body?.title ?? '').trim();
  const body = String(req.body?.body ?? '').trim();
  const image = String(req.body?.image ?? '').trim();
  const link = String(req.body?.link ?? '').trim();

  if (!title) {
    return res.status(400).json({ success: false, message: 'A title is required' });
  }
  if (!body) {
    return res.status(400).json({ success: false, message: 'A message is required' });
  }
  if (title.length > MAX_TITLE) {
    return res.status(400).json({
      success: false,
      message: `Keep the title under ${MAX_TITLE} characters`,
    });
  }
  if (body.length > MAX_BODY) {
    return res.status(400).json({
      success: false,
      message: `Keep the message under ${MAX_BODY} characters`,
    });
  }

  // Only ever a filename from our own uploads directory — never a full URL,
  // and never a path that could climb out of it.
  let imageUrl;
  if (image) {
    if (image.includes('/') || image.includes('\\') || image.includes('..')) {
      return res.status(400).json({ success: false, message: 'Invalid image reference' });
    }
    imageUrl = uploadPublicUrl(req, image);
  }

  const { url, error: linkError } = normaliseLink(link);
  if (linkError) {
    return res.status(400).json({ success: false, message: linkError });
  }

  // Recorded before the push, so the row's id can travel in the payload and
  // taps have something to attach themselves to. A send that then fails is
  // kept too, marked undelivered — a broadcast that did not go out is
  // precisely the thing an admin needs to see.
  const sender = await pool.query(
    `SELECT COALESCE(NULLIF(TRIM(CONCAT_WS(' ', first_name, last_name)), ''), name, email)
       AS display_name FROM users WHERE id = $1`,
    [req.userId],
  );

  const inserted = await pool.query(
    `INSERT INTO broadcasts (title, body, image_path, link_url, sent_by_user_id, sent_by_name)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [title, body, image || null, url || null, req.userId, sender.rows[0]?.display_name ?? null],
  );
  const broadcastId = inserted.rows[0].id;

  const result = await pushBroadcast({
    title,
    body,
    imageUrl,
    data: { broadcastId, ...(url ? { url } : {}) },
  });

  if (!result.sent) {
    await pool.query(
      `UPDATE broadcasts SET delivered = false, delivery_error = $2 WHERE id = $1`,
      [broadcastId, String(result.reason ?? 'unknown')],
    );
    // The push itself failed — say so rather than reporting a success the
    // admin would have no way to check.
    return res.status(502).json({
      success: false,
      message:
        result.reason === 'fcm_not_configured'
          ? 'Push notifications are not configured on the server'
          : `Could not send: ${result.reason}`,
      broadcastId,
    });
  }

  await pool.query(`UPDATE broadcasts SET fcm_message_id = $2 WHERE id = $1`, [
    broadcastId,
    result.messageId ?? null,
  ]);

  console.log(
    `[broadcast] user ${req.userId} sent #${broadcastId} "${title}"${url ? ` -> ${url}` : ''}`,
  );
  return res.json({
    success: true,
    id: broadcastId,
    messageId: result.messageId,
    link: url ?? null,
  });
};


function broadcastRowToJson(row, req) {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    imagePath: row.image_path ?? null,
    imageUrl: row.image_path ? uploadPublicUrl(req, row.image_path) : null,
    linkUrl: row.link_url ?? null,
    sentByName: row.sent_by_name ?? null,
    delivered: row.delivered,
    deliveryError: row.delivery_error ?? null,
    clicks: row.clicks,
    uniqueClicks: row.unique_clicks,
    createdAt: row.created_at,
  };
}

/**
 * GET /api/broadcast — admin-only history, newest first.
 *
 * Counts are computed from broadcast_clicks rather than kept as a column, so
 * they cannot drift. `clicks` is every tap; `uniqueClicks` counts distinct
 * signed-in people, and is always the smaller, more conservative number.
 */
export const listBroadcasts = async (req, res) => {
  const limit = Math.min(
    Math.max(parseInt(req.query.limit, 10) || 25, 1),
    MAX_HISTORY_PAGE,
  );
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

  const { rows } = await pool.query(
    `SELECT b.*,
            (SELECT COUNT(*)::int FROM broadcast_clicks c WHERE c.broadcast_id = b.id) AS clicks,
            (SELECT COUNT(DISTINCT c.user_id)::int FROM broadcast_clicks c
              WHERE c.broadcast_id = b.id AND c.user_id IS NOT NULL) AS unique_clicks
       FROM broadcasts b
      ORDER BY b.created_at DESC
      LIMIT $1 OFFSET $2`,
    [limit + 1, offset],
  );

  const hasMore = rows.length > limit;
  return res.json({
    success: true,
    broadcasts: rows.slice(0, limit).map((r) => broadcastRowToJson(r, req)),
    hasMore,
  });
};

/**
 * POST /api/broadcast/:id/click — records a tap.
 *
 * Open to signed-out devices (authOptional): a tap is worth counting whoever
 * made it, and requiring a session would quietly under-report. An unknown id
 * is a no-op rather than an error — the app should never show the user a
 * failure for something it did in the background.
 */
export const recordBroadcastClick = async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.json({ success: true });
  }
  try {
    await pool.query(
      `INSERT INTO broadcast_clicks (broadcast_id, user_id)
       SELECT $1, $2 WHERE EXISTS (SELECT 1 FROM broadcasts WHERE id = $1)`,
      [id, req.userId ?? null],
    );
  } catch (e) {
    console.error('[broadcast] click record failed:', e.message);
  }
  return res.json({ success: true });
};
