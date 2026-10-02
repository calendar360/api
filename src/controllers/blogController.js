import pool from '../db/pool.js';
import { uploadPublicUrl } from '../utils/publicUrl.js';
import { pushGlobalEvent } from '../services/fcmService.js';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;
const MAX_COMMENT_LENGTH = 2000;

/**
 * Admin-written posts about the global meetings, which every user can read,
 * like and comment on.
 *
 * Like and comment counts are aggregated per query rather than kept in
 * counter columns on blog_posts. At this scale the subqueries are cheap, and
 * a count derived from the rows can never drift out of step with them.
 */

// $1 is the reading user's id, or null when nobody is signed in — a null
// never equals l.user_id, so `likedByMe` is simply false for a guest.
const POST_COLUMNS = `
  p.id, p.title, p.excerpt, p.body, p.image_path, p.link_url, p.status,
  p.created_at, p.updated_at,
  to_char(p.meeting_date, 'YYYY-MM-DD') AS meeting_date,
  u.first_name, u.last_name, u.username, u.name,
  (SELECT COUNT(*) FROM blog_post_likes l WHERE l.post_id = p.id) AS like_count,
  (SELECT COUNT(*) FROM blog_post_comments c WHERE c.post_id = p.id) AS comment_count,
  EXISTS (
    SELECT 1 FROM blog_post_likes l
     WHERE l.post_id = p.id AND l.user_id = $1
  ) AS liked_by_me
`;

function displayName(row) {
  return (
    [row?.first_name, row?.last_name].filter(Boolean).join(' ') ||
    row?.username ||
    row?.name ||
    'Admin'
  );
}

function postToJson(row, req) {
  return {
    id: row.id,
    title: row.title,
    excerpt: row.excerpt ?? null,
    body: row.body ?? null,
    imagePath: row.image_path ?? null,
    imageUrl: row.image_path ? uploadPublicUrl(req, row.image_path) : null,
    linkUrl: row.link_url ?? null,
    meetingDate: row.meeting_date ?? null,
    status: row.status,
    authorName: displayName(row),
    likeCount: Number(row.like_count) || 0,
    commentCount: Number(row.comment_count) || 0,
    likedByMe: row.liked_by_me === true,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function commentToJson(row) {
  return {
    id: row.id,
    postId: row.post_id,
    userId: row.user_id,
    userName: row.user_name,
    message: row.message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Re-reads one post with its counts, so a write can answer with fresh state. */
async function loadPost(id, req) {
  const { rows } = await pool.query(
    `SELECT ${POST_COLUMNS}
       FROM blog_posts p
       LEFT JOIN users u ON u.id = p.created_by_user_id
      WHERE p.id = $2`,
    [req.userId ?? null, id],
  );
  return rows.length ? postToJson(rows[0], req) : null;
}

async function likeState(postId, userId) {
  const { rows } = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM blog_post_likes WHERE post_id = $1) AS like_count,
       EXISTS (
         SELECT 1 FROM blog_post_likes WHERE post_id = $1 AND user_id = $2
       ) AS liked_by_me`,
    [postId, userId ?? null],
  );
  return {
    likeCount: Number(rows[0].like_count) || 0,
    likedByMe: rows[0].liked_by_me === true,
  };
}

async function commentCount(postId) {
  const { rows } = await pool.query(
    'SELECT COUNT(*) AS n FROM blog_post_comments WHERE post_id = $1',
    [postId],
  );
  return Number(rows[0].n) || 0;
}

// ── Reading ─────────────────────────────────────────────────────────────────

/** GET /api/blog — newest first. Admins also see their own drafts. */
export async function listPosts(req, res) {
  try {
    const limit = Math.min(
      Math.max(Number(req.query.limit) || DEFAULT_PAGE_SIZE, 1),
      MAX_PAGE_SIZE,
    );
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    // A draft is an admin's unfinished working copy, so it stays hidden from
    // everyone else.
    const where = req.isAdmin ? '' : `WHERE p.status = 'published'`;

    const { rows } = await pool.query(
      `SELECT ${POST_COLUMNS}
         FROM blog_posts p
         LEFT JOIN users u ON u.id = p.created_by_user_id
         ${where}
        ORDER BY p.created_at DESC
        LIMIT $2 OFFSET $3`,
      [req.userId ?? null, limit, offset],
    );

    res.json({
      success: true,
      posts: rows.map((r) => postToJson(r, req)),
      limit,
      offset,
      hasMore: rows.length === limit,
    });
  } catch (e) {
    console.error('[blog] listPosts:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
}

/** GET /api/blog/:id */
export async function getPost(req, res) {
  try {
    const post = await loadPost(req.params.id, req);
    if (!post) {
      return res.status(404).json({ success: false, message: 'Post not found' });
    }
    if (post.status !== 'published' && !req.isAdmin) {
      return res.status(404).json({ success: false, message: 'Post not found' });
    }
    res.json({ success: true, post });
  } catch (e) {
    console.error('[blog] getPost:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
}

// ── Writing (admin) ─────────────────────────────────────────────────────────

/** POST /api/blog — creates a post and, unless it is a draft, notifies users. */
export async function createPost(req, res) {
  try {
    const { title, excerpt, body, imagePath, linkUrl, meetingDate, status, notify } =
      req.body;

    if (!title?.trim()) {
      return res.status(400).json({ success: false, message: 'title required' });
    }
    const safeStatus = status === 'draft' ? 'draft' : 'published';

    const { rows } = await pool.query(
      `INSERT INTO blog_posts
         (title, excerpt, body, image_path, link_url, meeting_date, status,
          created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        title.trim(),
        excerpt?.trim() || null,
        body?.trim() || null,
        imagePath || null,
        linkUrl?.trim() || null,
        meetingDate || null,
        safeStatus,
        req.userId,
      ],
    );

    const post = await loadPost(rows[0].id, req);

    // A draft has not been published, so it must never notify anyone.
    let fcm = { sent: false, reason: 'draft_not_notified' };
    if (safeStatus === 'published' && notify !== false) {
      fcm = await notifyNewPost(post);
    }

    res.status(201).json({ success: true, post, fcm });
  } catch (e) {
    console.error('[blog] createPost:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
}

/**
 * PUT /api/blog/:id
 *
 * Only the keys actually present in the body are written, so sending
 * `excerpt: ''` clears the excerpt — a COALESCE-everything update could never
 * empty a field once it had been set.
 */
export async function updatePost(req, res) {
  try {
    const { id } = req.params;
    const assignments = [];
    const values = [];

    const set = (column, value) => {
      values.push(value);
      assignments.push(`${column} = $${values.length}`);
    };

    if (req.body.title !== undefined) {
      if (!req.body.title?.trim()) {
        return res.status(400).json({ success: false, message: 'title required' });
      }
      set('title', req.body.title.trim());
    }
    if (req.body.excerpt !== undefined) set('excerpt', req.body.excerpt?.trim() || null);
    if (req.body.body !== undefined) set('body', req.body.body?.trim() || null);
    if (req.body.imagePath !== undefined) set('image_path', req.body.imagePath || null);
    if (req.body.linkUrl !== undefined) set('link_url', req.body.linkUrl?.trim() || null);
    if (req.body.meetingDate !== undefined) {
      set('meeting_date', req.body.meetingDate || null);
    }
    if (req.body.status !== undefined) {
      set('status', req.body.status === 'draft' ? 'draft' : 'published');
    }

    if (!assignments.length) {
      return res.status(400).json({ success: false, message: 'Nothing to update' });
    }

    values.push(id);
    const { rowCount } = await pool.query(
      `UPDATE blog_posts
          SET ${assignments.join(', ')}, updated_at = CURRENT_TIMESTAMP
        WHERE id = $${values.length}`,
      values,
    );
    if (!rowCount) {
      return res.status(404).json({ success: false, message: 'Post not found' });
    }

    const post = await loadPost(id, req);

    // Editing does not notify by default — only an explicit `notify: true`
    // does, which is how a draft gets announced when it goes live.
    let fcm = { sent: false, reason: 'not_requested' };
    if (req.body.notify === true && post.status === 'published') {
      fcm = await notifyNewPost(post);
    }

    res.json({ success: true, post, fcm });
  } catch (e) {
    console.error('[blog] updatePost:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
}

/** DELETE /api/blog/:id — likes and comments go with it via ON DELETE CASCADE. */
export async function deletePost(req, res) {
  try {
    const { rowCount } = await pool.query('DELETE FROM blog_posts WHERE id = $1', [
      req.params.id,
    ]);
    if (!rowCount) {
      return res.status(404).json({ success: false, message: 'Post not found' });
    }
    res.json({ success: true });
  } catch (e) {
    console.error('[blog] deletePost:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
}

function notifyNewPost(post) {
  const preview = (post.excerpt || post.body || '').replace(/\s+/g, ' ').trim();
  return pushGlobalEvent({
    title: post.title,
    body: preview
      ? preview.slice(0, 120) + (preview.length > 120 ? '…' : '')
      : 'Tap to read the latest post',
    eventId: String(post.id),
    extraData: { type: 'blog_post', postId: String(post.id) },
  });
}

// ── Likes ───────────────────────────────────────────────────────────────────

/** Confirms the post exists and is readable before it can be interacted with. */
async function publishedPostExists(id) {
  const { rows } = await pool.query(
    `SELECT 1 FROM blog_posts WHERE id = $1 AND status = 'published'`,
    [id],
  );
  return rows.length > 0;
}

/** POST /api/blog/:id/like — idempotent, so a double tap stays one like. */
export async function likePost(req, res) {
  try {
    const { id } = req.params;
    if (!(await publishedPostExists(id))) {
      return res.status(404).json({ success: false, message: 'Post not found' });
    }
    await pool.query(
      `INSERT INTO blog_post_likes (post_id, user_id) VALUES ($1, $2)
       ON CONFLICT (post_id, user_id) DO NOTHING`,
      [id, req.userId],
    );
    res.json({ success: true, ...(await likeState(id, req.userId)) });
  } catch (e) {
    console.error('[blog] likePost:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
}

/** DELETE /api/blog/:id/like — also idempotent. */
export async function unlikePost(req, res) {
  try {
    const { id } = req.params;
    if (!(await publishedPostExists(id))) {
      return res.status(404).json({ success: false, message: 'Post not found' });
    }
    await pool.query(
      'DELETE FROM blog_post_likes WHERE post_id = $1 AND user_id = $2',
      [id, req.userId],
    );
    res.json({ success: true, ...(await likeState(id, req.userId)) });
  } catch (e) {
    console.error('[blog] unlikePost:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
}

// ── Comments ────────────────────────────────────────────────────────────────

/** GET /api/blog/:id/comments — newest first, readable without signing in. */
export async function listComments(req, res) {
  try {
    const limit = Math.min(
      Math.max(Number(req.query.limit) || DEFAULT_PAGE_SIZE * 2, 1),
      100,
    );
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    const { rows } = await pool.query(
      `SELECT * FROM blog_post_comments
        WHERE post_id = $1
        ORDER BY created_at DESC
        LIMIT $2 OFFSET $3`,
      [req.params.id, limit, offset],
    );
    res.json({
      success: true,
      comments: rows.map(commentToJson),
      limit,
      offset,
      hasMore: rows.length === limit,
    });
  } catch (e) {
    console.error('[blog] listComments:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
}

/** POST /api/blog/:id/comments */
export async function createComment(req, res) {
  try {
    const { id } = req.params;
    const message = req.body.message?.trim();
    if (!message) {
      return res.status(400).json({ success: false, message: 'message required' });
    }
    if (message.length > MAX_COMMENT_LENGTH) {
      return res.status(400).json({
        success: false,
        message: `Comments are limited to ${MAX_COMMENT_LENGTH} characters`,
      });
    }
    if (!(await publishedPostExists(id))) {
      return res.status(404).json({ success: false, message: 'Post not found' });
    }

    const u = await pool.query(
      'SELECT first_name, last_name, username, name FROM users WHERE id = $1',
      [req.userId],
    );
    const userName = displayName(u.rows[0]) || 'Guest';

    const { rows } = await pool.query(
      `INSERT INTO blog_post_comments (post_id, user_id, user_name, message)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [id, req.userId, userName, message],
    );

    res.status(201).json({
      success: true,
      comment: commentToJson(rows[0]),
      commentCount: await commentCount(id),
    });
  } catch (e) {
    console.error('[blog] createComment:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
}

/** PUT /api/blog/:id/comments/:commentId — the author only. */
export async function updateComment(req, res) {
  try {
    const { id, commentId } = req.params;
    const message = req.body.message?.trim();
    if (!message) {
      return res.status(400).json({ success: false, message: 'message required' });
    }
    if (message.length > MAX_COMMENT_LENGTH) {
      return res.status(400).json({
        success: false,
        message: `Comments are limited to ${MAX_COMMENT_LENGTH} characters`,
      });
    }

    const existing = await pool.query(
      'SELECT user_id FROM blog_post_comments WHERE id = $1 AND post_id = $2',
      [commentId, id],
    );
    if (!existing.rows.length) {
      return res.status(404).json({ success: false, message: 'Comment not found' });
    }
    if (existing.rows[0].user_id !== req.userId) {
      return res.status(403).json({ success: false, message: 'Not your comment' });
    }

    const { rows } = await pool.query(
      `UPDATE blog_post_comments
          SET message = $1, updated_at = CURRENT_TIMESTAMP
        WHERE id = $2 RETURNING *`,
      [message, commentId],
    );
    res.json({ success: true, comment: commentToJson(rows[0]) });
  } catch (e) {
    console.error('[blog] updateComment:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
}

/**
 * DELETE /api/blog/:id/comments/:commentId
 *
 * The author, or an admin — a public comment thread needs someone able to
 * remove abuse, so [adminFlag] runs on this route.
 */
export async function deleteComment(req, res) {
  try {
    const { id, commentId } = req.params;
    const existing = await pool.query(
      'SELECT user_id FROM blog_post_comments WHERE id = $1 AND post_id = $2',
      [commentId, id],
    );
    if (!existing.rows.length) {
      return res.status(404).json({ success: false, message: 'Comment not found' });
    }
    if (existing.rows[0].user_id !== req.userId && !req.isAdmin) {
      return res.status(403).json({ success: false, message: 'Not your comment' });
    }

    await pool.query('DELETE FROM blog_post_comments WHERE id = $1', [commentId]);
    res.json({ success: true, commentCount: await commentCount(id) });
  } catch (e) {
    console.error('[blog] deleteComment:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
}
