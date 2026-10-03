import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pool from '../db/pool.js';
import { publicBaseUrl } from '../utils/publicUrl.js';
import { pushToUserId } from '../services/fcmService.js';
import { adImageToken, verifyAdImageToken } from '../services/paymentRefService.js';
import { advertUploadsDir } from '../routes/advertUploadRoute.js';
import { deleteAdvertImage } from '../services/advertImageStore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Where adverts used to be stored, back when they were world-readable. */
const legacyUploadsDir = path.join(__dirname, '../../uploads');

const PRICE_PER_HOUR_CENTS = 99;
// 30 days' worth of hours — the longest run the previous per-day code could
// produce, so nothing that used to be purchasable has become impossible.
const MAX_AD_HOURS = 720;
const MAX_QUEUE_PAGE = 100;

/**
 * How many adverts one account may have waiting for review at once.
 *
 * Submitting used to cost money, and that charge was what kept the queue
 * honest. Review is free now, so without a cap a single account could bury the
 * queue in work. Rejected and withdrawn adverts do not count, so a genuine
 * advertiser is never stuck.
 */
const MAX_PENDING_PER_USER = 3;

/**
 * How many adverts may be committed to the marquee at once.
 *
 * The strip scrolls at about 30px/second and each entry is roughly 200px, so
 * every extra advert stretches the time before any one of them comes round
 * again. At 20 a full cycle is a little over a minute, which an advertiser can
 * reasonably call exposure; at the old limit of 50 it was over five minutes
 * and nobody stays on the home screen that long.
 *
 * Counted as adverts already running plus adverts approved and awaiting
 * payment, because an approval is a promise of a slot.
 */
const MAX_CONCURRENT_LIVE_ADS = 20;

/**
 * Advert lifecycle. Review comes *before* payment:
 *
 *   pending_approval -> submitted, nothing charged, waiting for an admin
 *   approved_unpaid  -> an admin said yes; the advertiser is asked to pay
 *   active           -> paid, and running in the home marquee
 *   rejected         -> declined, with a reason. No money was ever taken.
 *   pending_review   -> paid, but the amount could not be confirmed
 *   cancelled        -> withdrawn by the advertiser, or taken down
 *   payment_failed   -> Espees reported a failure
 *   pending_payment  -> legacy only: a draft from the old pay-first flow
 *
 * Reviewing before charging is the whole point: a decline costs the advertiser
 * nothing, so there is no refund to arrange. The run window starts at payment,
 * which now happens after approval, so queue time cannot eat into it either.
 */
export const AD_STATUS = {
  pendingApproval: 'pending_approval',
  approvedUnpaid: 'approved_unpaid',
  active: 'active',
  rejected: 'rejected',
  pendingReview: 'pending_review',
  cancelled: 'cancelled',
};

/** Statuses an admin can act on, and which the queue therefore lists. */
const DECIDABLE = ['pending_approval', 'approved_unpaid', 'active', 'rejected', 'pending_review'];

function advertiserName(row) {
  return (
    [row?.first_name, row?.last_name].filter(Boolean).join(' ') ||
    row?.username ||
    row?.name ||
    'Unknown'
  );
}

/**
 * The advert's image URL, or null when the caller may not see it.
 *
 * An active advert is in the marquee, so its image is public. Anything else is
 * only readable with a per-advert token, which is handed out solely to the
 * owner and to admins.
 */
function adImageUrl(row, req, privileged) {
  if (!row.image_path) return null;
  const url = `${publicBaseUrl(req)}/api/ads/${row.id}/image`;
  if (row.status === 'active') return url;
  if (!privileged) return null;
  return `${url}?t=${adImageToken(row.id)}`;
}

function mapAd(row, req, { includeAdvertiser = false, privileged = false } = {}) {
  const ad = {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    description: row.description,
    imagePath: row.image_path,
    imageUrl: adImageUrl(row, req, privileged),
    linkUrl: row.link_url,
    startAt: row.start_at,
    endAt: row.end_at,
    durationHours: row.duration_hours ?? (row.duration_days ?? 1) * 24,
    amountCents: row.amount_cents,
    status: row.status,
    paymentId: row.payment_id,
    createdAt: row.created_at,
    paidAt: row.paid_at ?? null,
    approvedAt: row.approved_at ?? null,
    rejectionReason: row.rejection_reason ?? null,
  };
  // Only the admin queue needs to know who placed the advert.
  if (includeAdvertiser) {
    ad.advertiserName = advertiserName(row);
    ad.advertiserEmail = row.email ?? null;
  }
  return ad;
}

// ── Reading ─────────────────────────────────────────────────────────────────

export const listActiveAds = async (req, res) => {
  try {
    const now = new Date().toISOString();
    const result = await pool.query(
      `SELECT * FROM advertisements
       WHERE status = 'active' AND start_at <= $1 AND end_at >= $1
       ORDER BY RANDOM()
       LIMIT $2`,
      [now, MAX_CONCURRENT_LIVE_ADS],
    );
    res.json({ success: true, ads: result.rows.map((r) => mapAd(r, req)) });
  } catch (error) {
    console.error('listActiveAds', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

export const listMyAds = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM advertisements WHERE user_id = $1 ORDER BY created_at DESC`,
      [req.userId],
    );
    res.json({
      success: true,
      // Their own adverts, so they may see their own artwork at any status.
      ads: result.rows.map((r) => mapAd(r, req, { privileged: true })),
    });
  } catch (error) {
    console.error('listMyAds', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * GET /api/ads/:id/image
 *
 * The only way to read advert artwork. Public for an advert that is live,
 * token- or owner-gated otherwise.
 */
export const serveAdImage = async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, user_id, image_path, status FROM advertisements WHERE id = $1',
      [req.params.id],
    );
    if (!rows.length || !rows[0].image_path) return res.status(404).end();
    const ad = rows[0];

    const isLive = ad.status === 'active';
    const isOwner = req.userId != null && req.userId === ad.user_id;
    const allowed =
      isLive || isOwner || req.isAdmin === true || verifyAdImageToken(ad.id, req.query.t);
    if (!allowed) return res.status(403).end();

    // basename strips any path the stored value might carry, so a crafted
    // image_path cannot escape these two directories.
    const name = path.basename(ad.image_path);
    const file = [
      path.join(advertUploadsDir, name),
      // Adverts created before artwork moved out of the public directory.
      path.join(legacyUploadsDir, name),
    ].find((p) => fs.existsSync(p));
    if (!file) return res.status(404).end();

    res.set(
      'Cache-Control',
      isLive ? 'public, max-age=3600' : 'private, no-store',
    );
    return res.sendFile(file);
  } catch (error) {
    console.error('serveAdImage', error);
    return res.status(500).end();
  }
};

// ── Submitting ──────────────────────────────────────────────────────────────

/**
 * POST /api/ads — submits an advert for review. Nothing is charged here.
 *
 * The price is quoted back so the app can show what approval will cost, but
 * payment only becomes possible once an admin has approved it.
 */
export const createPendingAd = async (req, res) => {
  try {
    const {
      title,
      description,
      imagePath,
      linkUrl,
      durationHours: hoursRaw,
      // Builds already in the field send `durationDays`, but their own
      // duration dialog labelled that number as hours — so reading it as
      // hours is what those users were actually shown and charged for.
      durationDays: legacyHoursRaw,
    } = req.body;

    if (!title?.trim()) {
      return res.status(400).json({ success: false, message: 'title required' });
    }
    if (!imagePath?.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Image required for bottom marquee advert',
      });
    }

    const openCount = await pool.query(
      `SELECT COUNT(*)::int AS n FROM advertisements
        WHERE user_id = $1 AND status = 'pending_approval'`,
      [req.userId],
    );
    if (openCount.rows[0].n >= MAX_PENDING_PER_USER) {
      return res.status(429).json({
        success: false,
        message:
          `You already have ${MAX_PENDING_PER_USER} adverts waiting for review. ` +
          `Wait for one to be decided, or withdraw it, before submitting another.`,
        pendingLimit: MAX_PENDING_PER_USER,
      });
    }

    const durationHours = Math.min(
      MAX_AD_HOURS,
      Math.max(1, parseInt(hoursRaw ?? legacyHoursRaw, 10) || 1),
    );
    const amountCents = PRICE_PER_HOUR_CENTS * durationHours;

    // start_at/end_at are NOT NULL, so they are seeded here and then
    // overwritten with the real window when payment completes.
    const now = new Date();
    const provisionalEnd = new Date(now.getTime() + durationHours * 60 * 60 * 1000);

    const result = await pool.query(
      `INSERT INTO advertisements (
        user_id, title, description, image_path, link_url, start_at, end_at,
        amount_cents, duration_hours, status
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending_approval') RETURNING *`,
      [
        req.userId,
        title.trim(),
        description || null,
        path.basename(imagePath),
        linkUrl || null,
        now.toISOString(),
        provisionalEnd.toISOString(),
        amountCents,
        durationHours,
      ],
    );

    const ad = result.rows[0];
    await notifyAdminsOfSubmission(ad);

    res.status(201).json({
      success: true,
      ad: mapAd(ad, req, { privileged: true }),
      amount: amountCents / 100,
      durationHours,
      pricePerHour: PRICE_PER_HOUR_CENTS / 100,
    });
  } catch (error) {
    console.error('createPendingAd', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

async function notifyAdminsOfSubmission(ad) {
  const { pushToAdmins } = await import('../services/fcmService.js');
  const push = await pushToAdmins({
    title: 'Advert awaiting approval',
    body: `"${ad.title}" was submitted for review.`,
    data: { type: 'ad_approval', adId: String(ad.id) },
  });
  if (!push.sent) {
    console.warn('[ads] admin submission push not delivered:', push.reason || push);
  }
  return push;
}

export const cancelPendingAd = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `UPDATE advertisements SET status = 'cancelled'
       WHERE id = $1 AND user_id = $2
         AND status IN ('pending_payment', 'pending_approval', 'approved_unpaid')
       RETURNING *`,
      [id, req.userId],
    );
    if (!result.rows.length) {
      return res
        .status(404)
        .json({ success: false, message: 'No withdrawable advert found' });
    }
    // Withdrawn means it will never run, so the artwork is not kept. A
    // resubmission uploads again.
    await deleteAdvertImage(result.rows[0]);
    res.json({ success: true });
  } catch (error) {
    console.error('cancelPendingAd', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

export const deleteAd = async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await pool.query('SELECT * FROM advertisements WHERE id = $1', [id]);
    if (!existing.rows.length) {
      return res.status(404).json({ success: false, message: 'Ad not found' });
    }
    if (existing.rows[0].user_id !== req.userId) {
      const admin = await pool.query('SELECT is_admin FROM users WHERE id = $1', [req.userId]);
      if (!admin.rows[0]?.is_admin) {
        return res.status(403).json({ success: false, message: 'Not your ad' });
      }
    }
    const cancelled = await pool.query(
      `UPDATE advertisements SET status = 'cancelled' WHERE id = $1 RETURNING *`,
      [id],
    );
    await deleteAdvertImage(cancelled.rows[0]);
    res.json({ success: true });
  } catch (error) {
    console.error('deleteAd', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ── Admin approval queue ────────────────────────────────────────────────────

/**
 * GET /api/ads/pending-approval — newest first, paged.
 *
 * `?q=` filters on the advert's own text and on who placed it.
 * `?status=` narrows to one status; `all` means every status an admin can act
 * on, which includes `pending_review` — a payment whose amount could not be
 * confirmed, and which otherwise nobody would ever see.
 */
export const listPendingApproval = async (req, res) => {
  try {
    const limit = Math.min(
      Math.max(parseInt(req.query.limit, 10) || 25, 1),
      MAX_QUEUE_PAGE,
    );
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const status = [...DECIDABLE, 'all'].includes(req.query.status)
      ? req.query.status
      : 'pending_approval';

    const values = [];
    const where = [];

    if (status !== 'all') {
      values.push(status);
      where.push(`a.status = $${values.length}`);
    } else {
      values.push(DECIDABLE);
      where.push(`a.status = ANY($${values.length})`);
    }

    const q = req.query.q?.trim();
    if (q) {
      values.push(`%${q}%`);
      const p = `$${values.length}`;
      where.push(`(
        a.title ILIKE ${p} OR a.description ILIKE ${p} OR
        u.first_name ILIKE ${p} OR u.last_name ILIKE ${p} OR
        u.username ILIKE ${p} OR u.email ILIKE ${p}
      )`);
    }

    values.push(limit, offset);

    const { rows } = await pool.query(
      `SELECT a.*, u.first_name, u.last_name, u.username, u.name, u.email
         FROM advertisements a
         LEFT JOIN users u ON u.id = a.user_id
        WHERE ${where.join(' AND ')}
        ORDER BY a.created_at DESC
        LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );

    // The badges always describe the real backlog, never the current filter,
    // so searching cannot make outstanding work look as though it is gone.
    const counts = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'pending_approval')::int AS pending,
         COUNT(*) FILTER (WHERE status = 'pending_review')::int   AS review
       FROM advertisements`,
    );

    res.json({
      success: true,
      ads: rows.map((r) =>
        mapAd(r, req, { includeAdvertiser: true, privileged: true }),
      ),
      pendingCount: counts.rows[0].pending,
      reviewCount: counts.rows[0].review,
      committedSlots: await countCommittedSlots(),
      liveLimit: MAX_CONCURRENT_LIVE_ADS,
      limit,
      offset,
      hasMore: rows.length === limit,
    });
  } catch (error) {
    console.error('listPendingApproval', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Adverts occupying a marquee slot: running now, or approved and waiting to be
 * paid for. An approval reserves the slot, so it has to count — otherwise the
 * marquee could be oversubscribed the moment everyone pays.
 */
async function countCommittedSlots() {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM advertisements
      WHERE status = 'approved_unpaid'
         OR (status = 'active' AND end_at > now())`,
  );
  return rows[0].n;
}

/** GET /api/ads/pending-count — the badge numbers on their own. */
export const pendingApprovalCount = async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'pending_approval')::int AS pending,
         COUNT(*) FILTER (WHERE status = 'pending_review')::int   AS review
       FROM advertisements`,
    );
    res.json({
      success: true,
      pendingCount: rows[0].pending,
      reviewCount: rows[0].review,
      committedSlots: await countCommittedSlots(),
      liveLimit: MAX_CONCURRENT_LIVE_ADS,
    });
  } catch (error) {
    console.error('pendingApprovalCount', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * POST /api/ads/:id/approve
 *
 * Two different decisions share this route, because they are the same act from
 * the admin's side — "yes, this advert is fine":
 *
 *  - from `pending_approval`: approves it *for payment*. Nothing is charged
 *    and no run window starts; the advertiser is asked to pay.
 *  - from `pending_review`: the advertiser has already paid but the amount
 *    could not be confirmed. Approving accepts it and starts the run.
 *
 * The status in each WHERE clause is what makes this safe against two admins
 * acting at once: the second UPDATE matches nothing.
 */
export const approveAd = async (req, res) => {
  try {
    const { id } = req.params;
    const current = await pool.query(
      'SELECT status FROM advertisements WHERE id = $1',
      [id],
    );
    if (!current.rows.length) {
      return res.status(404).json({ success: false, message: 'Advert not found' });
    }
    const status = current.rows[0].status;
    const now = new Date().toISOString();

    // Both transitions below put an advert into the marquee's rotation, so
    // both are capped. Checked once here rather than inside each branch.
    const committed = await countCommittedSlots();
    if (committed >= MAX_CONCURRENT_LIVE_ADS) {
      const next = await pool.query(
        `SELECT MIN(end_at) AS soonest FROM advertisements
          WHERE status = 'active' AND end_at > now()`,
      );
      return res.status(409).json({
        success: false,
        message:
          `The marquee is full — ${committed} of ${MAX_CONCURRENT_LIVE_ADS} slots ` +
          `are taken by running or approved adverts. Approve this once a slot frees up.`,
        liveLimit: MAX_CONCURRENT_LIVE_ADS,
        committed,
        nextSlotAt: next.rows[0].soonest ?? null,
      });
    }

    if (status === 'pending_approval') {
      const { rows } = await pool.query(
        `UPDATE advertisements
            SET status = 'approved_unpaid',
                approved_at = $1,
                approved_by_user_id = $2,
                rejection_reason = NULL
          WHERE id = $3 AND status = 'pending_approval'
          RETURNING *`,
        [now, req.userId, id],
      );
      if (!rows.length) return conflict(res, id);

      const ad = rows[0];
      const amount = ((ad.amount_cents || 0) / 100).toFixed(2);
      const push = await pushToUserId(ad.user_id, {
        title: 'Your advert was approved',
        body: `"${ad.title}" is approved. Pay ${amount} ESP to put it live.`,
        data: { type: 'ad_approved_unpaid', adId: String(ad.id) },
      });
      return res.json({
        success: true,
        ad: mapAd(ad, req, { includeAdvertiser: true, privileged: true }),
        push,
      });
    }

    if (status === 'pending_review') {
      const { rows } = await pool.query(
        `UPDATE advertisements
            SET status = 'active',
                approved_at = $1,
                approved_by_user_id = $2,
                rejection_reason = NULL,
                start_at = $1,
                end_at = $1::timestamptz +
                  (COALESCE(duration_hours, COALESCE(duration_days, 1) * 24) || ' hours')::interval
          WHERE id = $3 AND status = 'pending_review'
          RETURNING *`,
        [now, req.userId, id],
      );
      if (!rows.length) return conflict(res, id);

      const ad = rows[0];
      const hours = ad.duration_hours || (ad.duration_days || 1) * 24;
      const push = await pushToUserId(ad.user_id, {
        title: 'Your advert is live',
        body: `"${ad.title}" is now running for ${hours} hour${hours === 1 ? '' : 's'}.`,
        data: { type: 'ad_approved', adId: String(ad.id) },
      });
      return res.json({
        success: true,
        ad: mapAd(ad, req, { includeAdvertiser: true, privileged: true }),
        push,
      });
    }

    return res.status(409).json({
      success: false,
      message: `Nothing to approve — advert is "${status}"`,
      status,
    });
  } catch (error) {
    console.error('approveAd', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

async function conflict(res, id) {
  const { rows } = await pool.query(
    'SELECT status FROM advertisements WHERE id = $1',
    [id],
  );
  return res.status(409).json({
    success: false,
    message: `Advert is already "${rows[0]?.status}"`,
    status: rows[0]?.status,
  });
}

/**
 * POST /api/ads/:id/reject
 *
 * A reason is required and is sent to the advertiser.
 *
 * Declining a `pending_approval` advert costs them nothing — that is the point
 * of reviewing before charging. Declining one that already paid (a
 * `pending_review` discrepancy, or a legacy pay-first advert) still needs a
 * refund arranged by hand; Espees has no refund call in this codebase.
 */
export const rejectAd = async (req, res) => {
  try {
    const { id } = req.params;
    const reason = req.body.reason?.trim();
    if (!reason) {
      return res.status(400).json({
        success: false,
        message: 'A reason is required — the advertiser is told why.',
      });
    }

    const { rows } = await pool.query(
      `UPDATE advertisements
          SET status = 'rejected',
              rejection_reason = $1,
              approved_by_user_id = $2,
              approved_at = NULL
        WHERE id = $3
          AND status IN ('pending_approval', 'approved_unpaid', 'pending_review')
        RETURNING *`,
      [reason, req.userId, id],
    );

    if (!rows.length) {
      const current = await pool.query(
        'SELECT status FROM advertisements WHERE id = $1',
        [id],
      );
      if (!current.rows.length) {
        return res.status(404).json({ success: false, message: 'Advert not found' });
      }
      return res.status(409).json({
        success: false,
        message: `Cannot decline an advert that is "${current.rows[0].status}"`,
        status: current.rows[0].status,
      });
    }

    const ad = rows[0];
    const wasPaid = ad.paid_at != null;
    // A declined advert will never run, so its artwork goes with it.
    await deleteAdvertImage(ad);
    const push = await pushToUserId(ad.user_id, {
      title: 'Your advert was not approved',
      body: reason.length > 120 ? `${reason.slice(0, 120)}…` : reason,
      data: { type: 'ad_rejected', adId: String(ad.id) },
    });

    res.json({
      success: true,
      ad: mapAd(ad, req, { includeAdvertiser: true, privileged: true }),
      // Flagged so the UI can warn that this one needs a manual refund.
      needsRefund: wasPaid,
      push,
    });
  } catch (error) {
    console.error('rejectAd', error);
    res.status(500).json({ success: false, message: error.message });
  }
};
