import pool from '../db/pool.js';
import { pushGlobalEvent } from '../services/fcmService.js';
import { uploadPublicUrl } from '../utils/publicUrl.js';

function mapEvent(row, req) {
  return {
    id: row.id,
    title: row.title,
    type: row.type,
    startTime: row.start_time,
    endTime: row.end_time,
    createdBy: row.created_by_user_id ? String(row.created_by_user_id) : null,
    isGlobal: row.is_global === true,
    color: row.color,
    reminder: row.reminder,
    description: row.description,
    imagePath: row.image_path,
    imageUrl: row.image_path ? uploadPublicUrl(req, row.image_path) : null,
    watchUrl: row.watch_url,
  };
}

export const listEvents = async (req, res) => {
  try {
    const userId = req.userId;
    let result;
    if (userId) {
      result = await pool.query(
        `SELECT * FROM events WHERE is_global = true OR created_by_user_id = $1 ORDER BY start_time ASC`,
        [userId],
      );
    } else {
      result = await pool.query(
        `SELECT * FROM events WHERE is_global = true ORDER BY start_time ASC`,
      );
    }
    res.json({
      success: true,
      events: result.rows.map((r) => mapEvent(r, req)),
    });
  } catch (error) {
    console.error('listEvents', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

export const createEvent = async (req, res) => {
  try {
    const {
      id,
      title,
      type,
      startTime,
      endTime,
      isGlobal,
      color,
      reminder,
      description,
      imagePath,
      watchUrl,
    } = req.body;

    if (!title || !startTime || !endTime) {
      return res.status(400).json({ success: false, message: 'title, startTime, endTime required' });
    }

    const eventId = id || `${Date.now()}`;
    const userId = req.userId;
    const global = isGlobal === true;

    if (global) {
      const user = await pool.query(
        'SELECT is_admin, is_paid FROM users WHERE id = $1',
        [userId],
      );
      const row = user.rows[0];
      const allowed =
        row?.is_admin === true ||
        row?.is_paid === true ||
        req.body.premiumGlobalPaid === true;
      if (!allowed) {
        return res.status(403).json({
          success: false,
          message: 'Premium required for global events',
        });
      }
    }

    await pool.query(
      `INSERT INTO events (
        id, title, type, start_time, end_time, created_by_user_id, is_global,
        color, reminder, description, image_path, watch_url
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        eventId,
        title,
        type || 'event',
        startTime,
        endTime,
        userId,
        global,
        color,
        reminder ?? 0,
        description,
        imagePath,
        watchUrl,
      ],
    );

    const row = (await pool.query('SELECT * FROM events WHERE id = $1', [eventId])).rows[0];
    console.log('[events] created id=%s userId=%s global=%s', eventId, userId, global);

    if (global) {
      pushGlobalEvent({
        title: 'New global event',
        body: title,
        eventId,
      }).catch((e) => console.error('[fcm] createEvent push', e));
    }

    res.status(201).json({ success: true, event: mapEvent(row, req) });
  } catch (error) {
    console.error('createEvent', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

export const updateEvent = async (req, res) => {
  try {
    const { id } = req.params;
    const fields = req.body;
    const existing = await pool.query('SELECT * FROM events WHERE id = $1', [id]);
    if (!existing.rows.length) {
      return res.status(404).json({ success: false, message: 'Event not found' });
    }

    const row = existing.rows[0];
    const becomingGlobal = fields.isGlobal === true && !row.is_global;
    if (row.is_global || becomingGlobal) {
      const user = await pool.query(
        'SELECT is_admin, is_paid FROM users WHERE id = $1',
        [req.userId],
      );
      const u = user.rows[0];
      const allowed =
        u?.is_admin === true ||
        u?.is_paid === true ||
        fields.premiumGlobalPaid === true;
      if (!allowed) {
        return res.status(403).json({ success: false, message: 'Premium required for global events' });
      }
    } else if (row.created_by_user_id !== req.userId) {
      return res.status(403).json({ success: false, message: 'Not your event' });
    }

    await pool.query(
      `UPDATE events SET
        title = COALESCE($1, title),
        type = COALESCE($2, type),
        start_time = COALESCE($3, start_time),
        end_time = COALESCE($4, end_time),
        is_global = COALESCE($5, is_global),
        color = COALESCE($6, color),
        reminder = COALESCE($7, reminder),
        description = COALESCE($8, description),
        image_path = COALESCE($9, image_path),
        watch_url = COALESCE($10, watch_url),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $11`,
      [
        fields.title,
        fields.type,
        fields.startTime,
        fields.endTime,
        fields.isGlobal,
        fields.color,
        fields.reminder,
        fields.description,
        fields.imagePath,
        fields.watchUrl,
        id,
      ],
    );

    const updated = (await pool.query('SELECT * FROM events WHERE id = $1', [id])).rows[0];
    res.json({ success: true, event: mapEvent(updated, req) });
  } catch (error) {
    console.error('updateEvent', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

export const deleteEvent = async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await pool.query('SELECT * FROM events WHERE id = $1', [id]);
    if (!existing.rows.length) {
      return res.status(404).json({ success: false, message: 'Event not found' });
    }
    const row = existing.rows[0];
    if (row.is_global) {
      const admin = await pool.query('SELECT is_admin FROM users WHERE id = $1', [req.userId]);
      if (!admin.rows[0]?.is_admin) {
        return res.status(403).json({ success: false, message: 'Admin only' });
      }
    } else if (row.created_by_user_id !== req.userId) {
      return res.status(403).json({ success: false, message: 'Not your event' });
    }

    await pool.query('DELETE FROM events WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (error) {
    console.error('deleteEvent', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

export const listWishes = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `SELECT w.*, u.first_name, u.last_name, u.username
       FROM birthday_wishes w
       LEFT JOIN users u ON u.id = w.user_id
       WHERE w.event_id = $1
       ORDER BY w.created_at DESC`,
      [id],
    );
    res.json({
      success: true,
      wishes: result.rows.map((w) => ({
        id: w.id,
        eventId: w.event_id,
        userName: w.user_name,
        message: w.message,
        createdAt: w.created_at,
      })),
    });
  } catch (error) {
    console.error('listWishes', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

export const createWish = async (req, res) => {
  try {
    const { id: eventId } = req.params;
    const { message, userName } = req.body;
    if (!message?.trim()) {
      return res.status(400).json({ success: false, message: 'message required' });
    }

    const userId = req.userId;
    let name = userName;
    if (!name && userId) {
      const u = await pool.query('SELECT first_name, last_name, username, name FROM users WHERE id = $1', [
        userId,
      ]);
      if (u.rows[0]) {
        const r = u.rows[0];
        name = [r.first_name, r.last_name].filter(Boolean).join(' ') || r.username || r.name;
      }
    }
    if (!name) name = 'Guest';

    const result = await pool.query(
      `INSERT INTO birthday_wishes (event_id, user_id, user_name, message)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [eventId, userId, name, message.trim()],
    );

    const w = result.rows[0];
    res.status(201).json({
      success: true,
      wish: {
        id: w.id,
        eventId: w.event_id,
        userName: w.user_name,
        message: w.message,
        createdAt: w.created_at,
      },
    });
  } catch (error) {
    console.error('createWish', error);
    res.status(500).json({ success: false, message: error.message });
  }
};
