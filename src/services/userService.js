import pool from '../db/pool.js';
import * as memoryStore from '../db/memoryStore.js';

async function pgAvailable() {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

export async function upsertUser({
  name,
  email,
  kingschatId,
  firebaseUid,
  firstName,
  lastName,
  username,
  avatar,
  profilePhoto,
  accessToken,
  refreshToken,
  isAdmin = false,
}) {
  const pgOk = await pgAvailable();
  if (!pgOk) {
    console.warn('[user] postgres unavailable — using memory store');
    return memoryStore.upsertKingschatUser({
      name,
      email,
      kcId: kingschatId || firebaseUid || email,
      accessToken,
      refreshToken,
      avatar: avatar || profilePhoto,
    });
  }

  let existing = null;

  if (kingschatId) {
    const r = await pool.query('SELECT * FROM users WHERE kingschat_id = $1', [kingschatId]);
    if (r.rows.length) existing = r.rows[0];
  }
  if (!existing && firebaseUid) {
    const r = await pool.query('SELECT * FROM users WHERE firebase_uid = $1', [firebaseUid]);
    if (r.rows.length) existing = r.rows[0];
  }
  if (!existing && email) {
    const r = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (r.rows.length) existing = r.rows[0];
  }

  if (existing) {
    const r = await pool.query(
      `UPDATE users SET
        name = $1, email = $2, firebase_uid = COALESCE($3, firebase_uid),
        first_name = $4, last_name = $5, username = $6,
        kingschat_id = COALESCE($7, kingschat_id),
        kingschat_access_token = COALESCE($8, kingschat_access_token),
        kingschat_refresh_token = COALESCE($9, kingschat_refresh_token),
        avatar = COALESCE($10, avatar), profile_photo = COALESCE($11, profile_photo),
        is_admin = $12, updated_at = CURRENT_TIMESTAMP
      WHERE id = $13 RETURNING *`,
      [
        name,
        email,
        firebaseUid,
        firstName,
        lastName,
        username,
        kingschatId,
        accessToken,
        refreshToken,
        avatar,
        profilePhoto,
        isAdmin,
        existing.id,
      ],
    );
    return r.rows[0];
  }

  const r = await pool.query(
    `INSERT INTO users (
      name, email, password, firebase_uid, first_name, last_name, username,
      kingschat_id, kingschat_access_token, kingschat_refresh_token,
      avatar, profile_photo, is_admin
    ) VALUES ($1,$2,'',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [
      name,
      email,
      firebaseUid,
      firstName,
      lastName,
      username,
      kingschatId,
      accessToken,
      refreshToken,
      avatar,
      profilePhoto,
      isAdmin,
    ],
  );
  return r.rows[0];
}
