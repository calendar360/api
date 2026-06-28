import pool from '../db/pool.js';
import { uploadPublicUrl } from '../utils/publicUrl.js';
import { pushGlobalEvent } from '../services/fcmService.js';

function requireAdmin(req, res) {
  if (!req.userId) {
    res.status(401).json({ success: false, message: 'Unauthorized' });
    return false;
  }
  if (!req.isAdmin) {
    res.status(403).json({ success: false, message: 'Admin only' });
    return false;
  }
  return true;
}

function rowToJson(row, req) {
  return {
    id: row.id,
    title: row.title,
    description: row.description ?? null,
    imagePath: row.image_path ?? null,
    imageUrl: row.image_path ? uploadPublicUrl(req, row.image_path) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** GET /api/on-this-day — list all posts, newest first */
export async function listPosts(req, res) {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM on_this_day ORDER BY created_at DESC`,
    );
    res.json({ success: true, posts: rows.map((r) => rowToJson(r, req)) });
  } catch (e) {
    console.error('listPosts', e);
    res.status(500).json({ success: false, message: e.message });
  }
}

/** GET /api/on-this-day/:id */
export async function getPost(req, res) {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM on_this_day WHERE id = $1`,
      [req.params.id],
    );
    if (!rows.length)
      return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, post: rowToJson(rows[0], req) });
  } catch (e) {
    console.error('getPost', e);
    res.status(500).json({ success: false, message: e.message });
  }
}

/** POST /api/on-this-day — admin creates post + triggers push notification */
export async function createPost(req, res) {
  if (!requireAdmin(req, res)) return;
  try {
    const { title, description, imagePath } = req.body;
    if (!title?.trim())
      return res.status(400).json({ success: false, message: 'title required' });

    const { rows } = await pool.query(
      `INSERT INTO on_this_day (title, description, image_path, created_by_user_id)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [title.trim(), description ?? null, imagePath ?? null, req.userId],
    );
    const post = rowToJson(rows[0], req);

    // Fire push notification to all subscribers
    const notifBody = description
      ? description.substring(0, 100) + (description.length > 100 ? '…' : '')
      : 'Tap to read more';

    const fcmResult = await pushGlobalEvent({
      title: `On This Day: ${title.trim()}`,
      body: notifBody,
      eventId: String(post.id),
      extraData: { type: 'on_this_day', postId: String(post.id) },
    });

    res.status(201).json({ success: true, post, fcm: fcmResult });
  } catch (e) {
    console.error('createPost', e);
    res.status(500).json({ success: false, message: e.message });
  }
}

/** PUT /api/on-this-day/:id — admin updates (no re-notification) */
export async function updatePost(req, res) {
  if (!requireAdmin(req, res)) return;
  try {
    const { id } = req.params;
    const { title, description, imagePath } = req.body;
    const { rows } = await pool.query(
      `UPDATE on_this_day
       SET title       = COALESCE($1, title),
           description = COALESCE($2, description),
           image_path  = COALESCE($3, image_path),
           updated_at  = CURRENT_TIMESTAMP
       WHERE id = $4 RETURNING *`,
      [title ?? null, description ?? null, imagePath ?? null, id],
    );
    if (!rows.length)
      return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, post: rowToJson(rows[0], req) });
  } catch (e) {
    console.error('updatePost', e);
    res.status(500).json({ success: false, message: e.message });
  }
}

/** DELETE /api/on-this-day/:id */
export async function deletePost(req, res) {
  if (!requireAdmin(req, res)) return;
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM on_this_day WHERE id = $1`,
      [req.params.id],
    );
    if (!rowCount)
      return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true });
  } catch (e) {
    console.error('deletePost', e);
    res.status(500).json({ success: false, message: e.message });
  }
}
