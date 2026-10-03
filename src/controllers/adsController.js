import pool from '../db/pool.js';
import { uploadPublicUrl } from '../utils/publicUrl.js';
import { pushToUserId } from '../services/fcmService.js';

const PRICE_PER_HOUR_CENTS = 99;
// 30 days' worth of hours — the longest run the previous per-day code could
// produce, so nothing that used to be purchasable has become impossible.
const MAX_AD_HOURS = 720;
const MAX_QUEUE_PAGE = 100;

/**
 * Advert lifecycle:
 *
 *   pending_payment  -> the draft, before Espees is paid
 *   pending_approval -> paid, waiting for an admin (see paymentController)
 *   active           -> approved and running in the home marquee
 *   rejected         -> an admin declined it, with a reason
 *   cancelled        -> withdrawn by the advertiser, or taken down
 *   payment_failed   -> Espees reported a failure
 *   pending_review   -> the amount Espees confirmed did not match the price
 *
 * Only `active` is ever served to the marquee, so nothing reaches users
 * without having been approved first.
 */
export const AD_STATUS = {
  pendingPayment: 'pending_payment',
  pendingApproval: 'pending_approval',
  active: 'active',
  rejected: 'rejected',
  cancelled: 'cancelled',
};

function advertiserName(row) {
  return (
    [row?.first_name, row?.last_name].filter(Boolean).join(' ') ||
    row?.username ||
    row?.name ||
    'Unknown'
  );
}

function mapAd(row, req, { includeAdvertiser = false } = {}) {
  const ad = {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    description: row.description,
    imagePath: row.image_path,
    imageUrl: row.image_path ? uploadPublicUrl(req, row.image_path) : null,
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
  // Only the admin queue needs to know who placed the advert; the advertiser's
  // own list does not, so their name is not handed out more widely than that.
  if (includeAdvertiser) {
    ad.advertiserName = advertiserName(row);
    ad.advertiserEmail = row.email ?? null;
  }
  return ad;
}

export const listActiveAds = async (req, res) => {
  try {
    const now = new Date().toISOString();
    const result = await pool.query(
      `SELECT * FROM advertisements
       WHERE status = 'active' AND start_at <= $1 AND end_at >= $1
       ORDER BY RANDOM()
       LIMIT 50`,
      [now],
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
    res.json({ success: true, ads: result.rows.map((r) => mapAd(r, req)) });
  } catch (error) {
    console.error('listMyAds', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/** Create advert awaiting Espees payment (0.99 ESP per hour once paid). */
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

    const durationHours = Math.min(
      MAX_AD_HOURS,
      Math.max(1, parseInt(hoursRaw ?? legacyHoursRaw, 10) || 1),
    );
    const amountCents = PRICE_PER_HOUR_CENTS * durationHours;

    const start = new Date();
    const end = new Date(start.getTime() + durationHours * 60 * 60 * 1000);

    const result = await pool.query(
      `INSERT INTO advertisements (
        user_id, title, description, image_path, link_url, start_at, end_at,
        amount_cents, duration_hours, status
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending_payment') RETURNING *`,
      [
        req.userId,
        title.trim(),
        description || null,
        imagePath,
        linkUrl || null,
        start.toISOString(),
        end.toISOString(),
        amountCents,
        durationHours,
      ],
    );

    res.status(201).json({
      success: true,
      ad: mapAd(result.rows[0], req),
      amount: amountCents / 100,
      durationHours,
      pricePerHour: PRICE_PER_HOUR_CENTS / 100,
    });
  } catch (error) {
    console.error('createPendingAd', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

export const cancelPendingAd = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `UPDATE advertisements SET status = 'cancelled'
       WHERE id = $1 AND user_id = $2 AND status = 'pending_payment'
       RETURNING id`,
      [id, req.userId],
    );
    if (!result.rows.length) {
      return res.status(404).json({ success: false, message: 'Pending advert not found' });
    }
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
    await pool.query(`UPDATE advertisements SET status = 'cancelled' WHERE id = $1`, [id]);
    res.json({ success: true });
  } catch (error) {
    console.error('deleteAd', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ── Admin approval queue ────────────────────────────────────────────────────

/**
 * GET /api/ads/pending-approval — newest first.
 *
 * `?q=` filters on the advert's own text and on who placed it, so an admin
 * chasing one submission does not have to scroll the queue.
 * `?status=` can widen it to a decided advert, for looking up what was done.
 */
export const listPendingApproval = async (req, res) => {
  try {
    const limit = Math.min(
      Math.max(parseInt(req.query.limit, 10) || 50, 1),
      MAX_QUEUE_PAGE,
    );
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const allowed = ['pending_approval', 'active', 'rejected', 'all'];
    const status = allowed.includes(req.query.status)
      ? req.query.status
      : 'pending_approval';

    const values = [];
    const where = [];

    if (status !== 'all') {
      values.push(status);
      where.push(`a.status = $${values.length}`);
    } else {
      // "All" still means decided adverts only — an unpaid draft is not
      // something an admin can act on.
      where.push(`a.status IN ('pending_approval', 'active', 'rejected')`);
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

    // The badge count always reflects the queue itself, never the filter, so
    // searching cannot make pending work look as though it has gone away.
    const countRes = await pool.query(
      `SELECT COUNT(*)::int AS n FROM advertisements WHERE status = 'pending_approval'`,
    );

    res.json({
      success: true,
      ads: rows.map((r) => mapAd(r, req, { includeAdvertiser: true })),
      pendingCount: countRes.rows[0].n,
      limit,
      offset,
      hasMore: rows.length === limit,
    });
  } catch (error) {
    console.error('listPendingApproval', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/** GET /api/ads/pending-count — just the badge number. */
export const pendingApprovalCount = async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM advertisements WHERE status = 'pending_approval'`,
    );
    res.json({ success: true, pendingCount: rows[0].n });
  } catch (error) {
    console.error('pendingApprovalCount', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * POST /api/ads/:id/approve
 *
 * The run window is restarted from the moment of approval rather than kept
 * from when payment went through. The advertiser paid for a number of days of
 * exposure, and time spent waiting in this queue is not exposure.
 *
 * The status guard in the WHERE clause is what makes this safe against two
 * admins approving the same advert at once: the second UPDATE matches nothing.
 */
export const approveAd = async (req, res) => {
  try {
    const { id } = req.params;
    const start = new Date();

    const { rows } = await pool.query(
      `UPDATE advertisements
          SET status = 'active',
              approved_at = $1,
              approved_by_user_id = $2,
              rejection_reason = NULL,
              start_at = $1,
              end_at = $1::timestamptz +
                (COALESCE(duration_hours, COALESCE(duration_days, 1) * 24) || ' hours')::interval
        WHERE id = $3 AND status = 'pending_approval'
        RETURNING *`,
      [start.toISOString(), req.userId, id],
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
        message: `Advert is already "${current.rows[0].status}"`,
        status: current.rows[0].status,
      });
    }

    const ad = rows[0];
    const hours = ad.duration_hours || (ad.duration_days || 1) * 24;
    const push = await pushToUserId(ad.user_id, {
      title: 'Your advert is live',
      body: `"${ad.title}" is now running for ${hours} hour${hours === 1 ? '' : 's'}.`,
      data: { type: 'ad_approved', adId: String(ad.id) },
    });

    res.json({ success: true, ad: mapAd(ad, req, { includeAdvertiser: true }), push });
  } catch (error) {
    console.error('approveAd', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * POST /api/ads/:id/reject
 *
 * A reason is required, and it is sent to the advertiser — being turned down
 * with no explanation after paying is not something to ship.
 *
 * Note that this does not refund anything. Espees has no refund call in this
 * codebase, so a rejected advert has to be refunded by hand.
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
        WHERE id = $3 AND status = 'pending_approval'
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
        message: `Advert is already "${current.rows[0].status}"`,
        status: current.rows[0].status,
      });
    }

    const ad = rows[0];
    const push = await pushToUserId(ad.user_id, {
      title: 'Your advert was not approved',
      body: reason.length > 120 ? `${reason.slice(0, 120)}…` : reason,
      data: { type: 'ad_rejected', adId: String(ad.id) },
    });

    res.json({ success: true, ad: mapAd(ad, req, { includeAdvertiser: true }), push });
  } catch (error) {
    console.error('rejectAd', error);
    res.status(500).json({ success: false, message: error.message });
  }
};
