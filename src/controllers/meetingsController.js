import pool from '../db/pool.js';
import { pushToUser } from '../services/fcmService.js';

function formatMeeting(row, invitees = []) {
  return {
    id: row.id,
    title: row.title,
    description: row.description || null,
    startTime: row.start_time,
    endTime: row.end_time || null,
    color: row.color || null,
    reminder: row.reminder ?? 15,
    organizerId: row.organizer_id,
    organizerName: `${row.first_name || ''} ${row.last_name || ''}`.trim(),
    organizerUsername: row.username || '',
    organizerAvatar: row.avatar || row.profile_photo || null,
    myStatus: row.my_status ?? null,
    invitees,
  };
}

async function fetchInviteesForMeetings(meetingIds) {
  if (!meetingIds.length) return {};
  const result = await pool.query(
    `SELECT mi.meeting_id, mi.user_id, mi.status,
            u.first_name, u.last_name, u.username, u.avatar
     FROM meeting_invitees mi
     JOIN users u ON u.id = mi.user_id
     WHERE mi.meeting_id = ANY($1)`,
    [meetingIds],
  );
  const map = {};
  for (const row of result.rows) {
    if (!map[row.meeting_id]) map[row.meeting_id] = [];
    map[row.meeting_id].push({
      userId: row.user_id,
      name: `${row.first_name || ''} ${row.last_name || ''}`.trim(),
      username: row.username || '',
      avatar: row.avatar || null,
      status: row.status,
    });
  }
  return map;
}

// GET /api/meetings/mine
export async function getMyMeetings(req, res) {
  const userId = req.userId;
  try {
    const organized = await pool.query(
      `SELECT m.*, u.first_name, u.last_name, u.username, u.avatar, NULL::text AS my_status
       FROM meetings m
       JOIN users u ON u.id = m.organizer_id
       WHERE m.organizer_id = $1
       ORDER BY m.start_time ASC`,
      [userId],
    );

    const accepted = await pool.query(
      `SELECT m.*, u.first_name, u.last_name, u.username, u.avatar, mi.status AS my_status
       FROM meetings m
       JOIN meeting_invitees mi ON mi.meeting_id = m.id AND mi.user_id = $1
       JOIN users u ON u.id = m.organizer_id
       WHERE mi.status = 'accepted'
       ORDER BY m.start_time ASC`,
      [userId],
    );

    const allRows = [...organized.rows, ...accepted.rows];
    const meetingIds = allRows.map((r) => r.id);
    const inviteesMap = await fetchInviteesForMeetings(meetingIds);

    const meetings = allRows
      .map((row) => formatMeeting(row, inviteesMap[row.id] || []))
      .sort((a, b) => new Date(a.startTime) - new Date(b.startTime));

    res.json({ success: true, meetings });
  } catch (e) {
    console.error('[meetings] getMyMeetings:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
}

// GET /api/meetings/invitations
export async function getPendingInvitations(req, res) {
  const userId = req.userId;
  try {
    const result = await pool.query(
      `SELECT m.*, u.first_name, u.last_name, u.username, u.avatar, mi.status AS my_status
       FROM meetings m
       JOIN meeting_invitees mi ON mi.meeting_id = m.id AND mi.user_id = $1
       JOIN users u ON u.id = m.organizer_id
       WHERE mi.status = 'pending'
       ORDER BY m.start_time ASC`,
      [userId],
    );

    const invitations = result.rows.map((row) => formatMeeting(row));
    res.json({ success: true, invitations, count: invitations.length });
  } catch (e) {
    console.error('[meetings] getPendingInvitations:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
}

// POST /api/meetings
export async function createMeeting(req, res) {
  const userId = req.userId;
  const { title, description, startTime, endTime, color, reminder } = req.body;

  if (!title || !startTime) {
    return res.status(400).json({ success: false, message: 'Title and startTime are required' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO meetings (title, description, start_time, end_time, color, reminder, organizer_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [title, description || null, startTime, endTime || null, color || null, reminder ?? 15, userId],
    );
    const meeting = result.rows[0];

    const orgResult = await pool.query(
      'SELECT first_name, last_name, username, avatar FROM users WHERE id = $1',
      [userId],
    );
    const org = orgResult.rows[0] || {};

    res.json({ success: true, meeting: formatMeeting({ ...meeting, ...org }, []) });
  } catch (e) {
    console.error('[meetings] createMeeting:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
}

// POST /api/meetings/:id/invite
export async function inviteToMeeting(req, res) {
  const organizerId = req.userId;
  const meetingId = parseInt(req.params.id, 10);
  const { usernames } = req.body;

  if (!Array.isArray(usernames) || usernames.length === 0) {
    return res.status(400).json({ success: false, message: 'usernames array required' });
  }

  try {
    const meetingResult = await pool.query(
      'SELECT * FROM meetings WHERE id = $1 AND organizer_id = $2',
      [meetingId, organizerId],
    );
    if (!meetingResult.rows.length) {
      return res.status(403).json({ success: false, message: 'Meeting not found or not authorized' });
    }
    const meeting = meetingResult.rows[0];

    const orgResult = await pool.query(
      'SELECT first_name, last_name FROM users WHERE id = $1',
      [organizerId],
    );
    const org = orgResult.rows[0] || {};
    const organizerName = `${org.first_name || ''} ${org.last_name || ''}`.trim();

    const usersResult = await pool.query(
      'SELECT id, username, fcm_token FROM users WHERE username = ANY($1)',
      [usernames],
    );

    const invited = [];
    const notFound = usernames.filter(
      (u) => !usersResult.rows.find((r) => r.username === u),
    );

    for (const user of usersResult.rows) {
      if (user.id === organizerId) continue;
      try {
        await pool.query(
          `INSERT INTO meeting_invitees (meeting_id, user_id, status)
           VALUES ($1, $2, 'pending')
           ON CONFLICT (meeting_id, user_id) DO NOTHING`,
          [meetingId, user.id],
        );
        invited.push(user.username);

        if (user.fcm_token) {
          pushToUser(user.fcm_token, {
            title: 'Meeting Invitation',
            body: `${organizerName} invited you to "${meeting.title}"`,
            data: { type: 'meeting_invitation', meetingId: String(meetingId) },
          }).catch((e) => console.error('[fcm] invite push:', e.message));
        }
      } catch (e) {
        console.error('[meetings] invite for', user.username, e.message);
      }
    }

    res.json({ success: true, invited, notFound });
  } catch (e) {
    console.error('[meetings] inviteToMeeting:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
}

// PATCH /api/meetings/:id/respond
export async function respondToMeeting(req, res) {
  const userId = req.userId;
  const meetingId = parseInt(req.params.id, 10);
  const { status } = req.body;

  if (!['accepted', 'declined'].includes(status)) {
    return res.status(400).json({ success: false, message: 'status must be accepted or declined' });
  }

  try {
    const result = await pool.query(
      `UPDATE meeting_invitees
       SET status = $1, responded_at = CURRENT_TIMESTAMP
       WHERE meeting_id = $2 AND user_id = $3
       RETURNING *`,
      [status, meetingId, userId],
    );

    if (!result.rows.length) {
      return res.status(404).json({ success: false, message: 'Invitation not found' });
    }

    if (status === 'accepted') {
      const row = await pool.query(
        `SELECT m.title, u_org.fcm_token, u_me.first_name, u_me.last_name
         FROM meetings m
         JOIN users u_org ON u_org.id = m.organizer_id
         JOIN users u_me ON u_me.id = $1
         WHERE m.id = $2`,
        [userId, meetingId],
      );
      if (row.rows.length) {
        const { fcm_token, first_name, last_name, title } = row.rows[0];
        const acceptorName = `${first_name || ''} ${last_name || ''}`.trim();
        if (fcm_token) {
          pushToUser(fcm_token, {
            title: 'Meeting Accepted',
            body: `${acceptorName} accepted your invite to "${title}"`,
            data: { type: 'meeting_accepted', meetingId: String(meetingId) },
          }).catch(() => {});
        }
      }
    }

    res.json({ success: true, status });
  } catch (e) {
    console.error('[meetings] respondToMeeting:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
}

// DELETE /api/meetings/:id
export async function deleteMeeting(req, res) {
  const userId = req.userId;
  const meetingId = parseInt(req.params.id, 10);
  try {
    const result = await pool.query(
      'DELETE FROM meetings WHERE id = $1 AND organizer_id = $2 RETURNING id',
      [meetingId, userId],
    );
    if (!result.rows.length) {
      return res.status(404).json({ success: false, message: 'Meeting not found' });
    }
    res.json({ success: true });
  } catch (e) {
    console.error('[meetings] deleteMeeting:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
}

// GET /api/meetings/search-users?q=term  — matches KingsChat username only
export async function searchUsers(req, res) {
  const q = (req.query.q || '').trim();
  if (q.length < 1) {
    return res.json({ success: true, users: [] });
  }
  const callerId = req.userId;
  try {
    const result = await pool.query(
      `SELECT id, first_name, last_name, username, avatar, kingschat_id
       FROM users
       WHERE username ILIKE $1
         AND id != $2
       LIMIT 15`,
      [`%${q}%`, callerId],
    );
    const users = result.rows.map((r) => ({
      id: r.id,
      name: `${r.first_name || ''} ${r.last_name || ''}`.trim(),
      username: r.username || '',
      avatar: r.avatar || null,
    }));
    res.json({ success: true, users });
  } catch (e) {
    console.error('[meetings] searchUsers:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
}
