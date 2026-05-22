import pool from '../db/pool.js';
import { uploadPublicUrl } from '../utils/publicUrl.js';

const PRICE_PER_DAY_CENTS = 99;
const MAX_AD_DAYS = 30;

function mapAd(row, req) {
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    description: row.description,
    imagePath: row.image_path,
    imageUrl: row.image_path ? uploadPublicUrl(req, row.image_path) : null,
    linkUrl: row.link_url,
    startAt: row.start_at,
    endAt: row.end_at,
    durationDays: row.duration_days ?? 1,
    amountCents: row.amount_cents,
    status: row.status,
    paymentId: row.payment_id,
  };
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

/** Create advert awaiting Espees payment ($0.99 / 24h once paid). */
export const createPendingAd = async (req, res) => {
  try {
    const { title, description, imagePath, linkUrl, durationDays: daysRaw } = req.body;

    if (!title?.trim()) {
      return res.status(400).json({ success: false, message: 'title required' });
    }
    if (!imagePath?.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Image required for bottom marquee advert',
      });
    }

    const durationDays = Math.min(
      MAX_AD_DAYS,
      Math.max(1, parseInt(daysRaw, 10) || 1),
    );
    const amountCents = PRICE_PER_DAY_CENTS * durationDays;

    const start = new Date();
    const end = new Date(start.getTime() + durationDays * 24 * 60 * 60 * 1000);

    const result = await pool.query(
      `INSERT INTO advertisements (
        user_id, title, description, image_path, link_url, start_at, end_at,
        amount_cents, duration_days, status
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
        durationDays,
      ],
    );

    res.status(201).json({
      success: true,
      ad: mapAd(result.rows[0], req),
      amount: amountCents / 100,
      durationDays,
      pricePerDay: PRICE_PER_DAY_CENTS / 100,
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
