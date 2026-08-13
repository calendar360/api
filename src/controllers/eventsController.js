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
    isYearly: row.is_yearly === true,
    hideTime: row.hide_time === true,
    personName: row.person_name,
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
      isYearly,
      hideTime,
      personName,
      color,
      reminder,
      description,
      imagePath,
      watchUrl,
    } = req.body;

    if (!title || !startTime) {
      return res.status(400).json({ success: false, message: 'title and startTime required' });
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
        is_yearly, hide_time, person_name, color, reminder, description, image_path, watch_url
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        eventId,
        title,
        type || 'event',
        startTime,
        endTime,
        userId,
        global,
        isYearly === true,
        hideTime === true,
        personName,
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
        is_yearly = COALESCE($6, is_yearly),
        hide_time = COALESCE($7, hide_time),
        person_name = COALESCE($8, person_name),
        color = COALESCE($9, color),
        reminder = COALESCE($10, reminder),
        description = COALESCE($11, description),
        image_path = COALESCE($12, image_path),
        watch_url = COALESCE($13, watch_url),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $14`,
      [
        fields.title,
        fields.type,
        fields.startTime,
        fields.endTime,
        fields.isGlobal,
        fields.isYearly === true ? true : (fields.isYearly === false ? false : null),
        fields.hideTime === true ? true : (fields.hideTime === false ? false : null),
        fields.personName,
        fields.color,
        fields.reminder,
        fields.description,
        fields.imagePath,
        fields.watchUrl,
        id,
      ],
    );

    const updated = (await pool.query('SELECT * FROM events WHERE id = $1', [id])).rows[0];

    if (updated.is_global) {
      pushGlobalEvent({
        title: 'Global event updated',
        body: updated.title,
        eventId: id,
      }).catch((e) => console.error('[fcm] updateEvent push', e));
    }

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

export const listImportantBirthdays = async (req, res) => {
  try {
    const userId = req.userId;
    const birthdayFilter = `(LOWER(type) LIKE '%birthday%' OR LOWER(title) LIKE '%birthday%')`;
    let result;
    if (userId) {
      result = await pool.query(
        `SELECT * FROM events WHERE ${birthdayFilter} AND (is_global = true OR created_by_user_id = $1) ORDER BY start_time ASC`,
        [userId],
      );
    } else {
      result = await pool.query(
        `SELECT * FROM events WHERE ${birthdayFilter} AND is_global = true ORDER BY start_time ASC`,
      );
    }
    res.json({
      success: true,
      birthdays: result.rows.map((row) => ({
        ...mapEvent(row, req),
        displayTitle: row.person_name ? `${row.person_name}'s Birthday` : row.title,
      })),
    });
  } catch (error) {
    console.error('listImportantBirthdays', error);
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
        userId: w.user_id,
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
        userId: w.user_id,
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

export const updateWish = async (req, res) => {
  try {
    const { id: eventId, wishId } = req.params;
    const { message } = req.body;
    if (!message?.trim()) {
      return res.status(400).json({ success: false, message: 'message required' });
    }

    const existing = await pool.query(
      'SELECT * FROM birthday_wishes WHERE id = $1 AND event_id = $2',
      [wishId, eventId],
    );
    if (!existing.rows.length) {
      return res.status(404).json({ success: false, message: 'Message not found' });
    }
    if (existing.rows[0].user_id !== req.userId) {
      return res.status(403).json({ success: false, message: 'Not your message' });
    }

    const result = await pool.query(
      `UPDATE birthday_wishes SET message = $1 WHERE id = $2 RETURNING *`,
      [message.trim(), wishId],
    );

    const w = result.rows[0];
    res.json({
      success: true,
      wish: {
        id: w.id,
        eventId: w.event_id,
        userId: w.user_id,
        userName: w.user_name,
        message: w.message,
        createdAt: w.created_at,
      },
    });
  } catch (error) {
    console.error('updateWish', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

export const deleteWish = async (req, res) => {
  try {
    const { id: eventId, wishId } = req.params;
    const existing = await pool.query(
      'SELECT * FROM birthday_wishes WHERE id = $1 AND event_id = $2',
      [wishId, eventId],
    );
    if (!existing.rows.length) {
      return res.status(404).json({ success: false, message: 'Message not found' });
    }
    if (existing.rows[0].user_id !== req.userId) {
      return res.status(403).json({ success: false, message: 'Not your message' });
    }

    await pool.query('DELETE FROM birthday_wishes WHERE id = $1', [wishId]);
    res.json({ success: true });
  } catch (error) {
    console.error('deleteWish', error);
    res.status(500).json({ success: false, message: error.message });
  }
};
