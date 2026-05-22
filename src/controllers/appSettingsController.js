import pool from '../db/pool.js';
import { uploadPublicUrl } from '../utils/publicUrl.js';

const BIRTHDAY_BANNER_KEY = 'birthdayBannerImageUrl';

function resolveAssetUrl(req, value) {
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value;
  return uploadPublicUrl(req, value);
}

async function getSetting(key) {
  const result = await pool.query('SELECT value FROM app_settings WHERE key = $1', [key]);
  return result.rows[0]?.value ?? null;
}

export const getAppSettings = async (_req, res) => {
  try {
    const raw = await getSetting(BIRTHDAY_BANNER_KEY);
    res.json({
      success: true,
      birthdayBannerImageUrl: raw,
      birthdayBannerImageUrlResolved: resolveAssetUrl(_req, raw),
    });
  } catch (error) {
    console.error('getAppSettings', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

export const setBirthdayBanner = async (req, res) => {
  try {
    const admin = await pool.query('SELECT is_admin FROM users WHERE id = $1', [req.userId]);
    if (!admin.rows[0]?.is_admin) {
      return res.status(403).json({ success: false, message: 'Admin only' });
    }

    const url = (req.body?.birthdayBannerImageUrl ?? req.body?.url ?? '').trim();
    await pool.query(
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES ($1, $2, CURRENT_TIMESTAMP)
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = CURRENT_TIMESTAMP`,
      [BIRTHDAY_BANNER_KEY, url || null],
    );

    res.json({
      success: true,
      birthdayBannerImageUrl: url || null,
      birthdayBannerImageUrlResolved: resolveAssetUrl(req, url || null),
    });
  } catch (error) {
    console.error('setBirthdayBanner', error);
    res.status(500).json({ success: false, message: error.message });
  }
};
