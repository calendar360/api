import pool from "../db/pool.js";
import { uploadPublicUrl } from "../utils/publicUrl.js";
import { pushGlobalEvent } from "../services/fcmService.js";

async function requireAdmin(req, res) {
  if (!req.userId) {
    res.status(401).json({ success: false, message: "Unauthorized" });
    return false;
  }
  const result = await pool.query("SELECT is_admin FROM users WHERE id = $1", [
    req.userId,
  ]);
  if (!result.rows[0]?.is_admin) {
    res.status(403).json({ success: false, message: "Admin only" });
    return false;
  }
  return true;
}

// Counts are read as subqueries rather than kept on the row, so they cannot
// drift away from the view log.
//
// Admins are excluded from the reader-facing totals: an admin opening a post
// to check it is not readership, and leaving and returning would otherwise
// inflate its own numbers. The view rows are still written, so this is a
// presentation rule that can be changed later without having lost anything.
// LEFT JOIN, not JOIN, or signed-out views (user_id IS NULL) would drop out.
const VIEW_COUNTS = `
  (SELECT COUNT(*)::int FROM on_this_day_views v
    LEFT JOIN users u ON u.id = v.user_id
   WHERE v.post_id = p.id AND COALESCE(u.is_admin, false) = false) AS view_count,
  (SELECT COUNT(DISTINCT v.user_id)::int FROM on_this_day_views v
    JOIN users u ON u.id = v.user_id
   WHERE v.post_id = p.id AND COALESCE(u.is_admin, false) = false) AS unique_views,
  (SELECT COUNT(*)::int FROM on_this_day_views v
    JOIN users u ON u.id = v.user_id
   WHERE v.post_id = p.id
     AND LOWER(u.email) IN (SELECT email FROM tracked_viewers)) AS tracked_views`;

function rowToJson(row, req) {
  return {
    id: row.id,
    title: row.title,
    description: row.description ?? null,
    imagePath: row.image_path ?? null,
    imageUrl: row.image_path ? uploadPublicUrl(req, row.image_path) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // Admin-only: readers have no business knowing how a post is performing,
    // and the field is left out entirely rather than sent as zero.
    ...(req.isAdmin
      ? {
          viewCount: row.view_count ?? 0,
          uniqueViews: row.unique_views ?? 0,
          trackedViews: row.tracked_views ?? 0,
        }
      : {}),
    // Only ever set by [getPost], and only for an admin.
    ...(row.tracked_viewers ? { trackedViewers: row.tracked_viewers } : {}),
  };
}

/** GET /api/on-this-day — list all posts, newest first */
export async function listPosts(req, res) {
  try {
    const { rows } = await pool.query(
      `SELECT p.*, ${VIEW_COUNTS} FROM on_this_day p ORDER BY p.created_at DESC`,
    );
    res.json({ success: true, posts: rows.map((r) => rowToJson(r, req)) });
  } catch (e) {
    console.error("listPosts", e);
    res.status(500).json({ success: false, message: e.message });
  }
}

/** GET /api/on-this-day/:id */
export async function getPost(req, res) {
  // Parsed rather than passed through: the column is an integer, so a
  // non-numeric segment would reach Postgres and come back as a 500.
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(404).json({ success: false, message: "Not found" });
  }
  try {
    const { rows } = await pool.query(
      `SELECT p.*, ${VIEW_COUNTS} FROM on_this_day p WHERE p.id = $1`,
      [id],
    );
    if (!rows.length)
      return res.status(404).json({ success: false, message: "Not found" });
    // Per-account breakdown, on the single-post read only — the feed would
    // need one of these per row.
    if (req.isAdmin) {
      rows[0].tracked_viewers = await trackedBreakdown(id);
    }
    res.json({ success: true, post: rowToJson(rows[0], req) });
  } catch (e) {
    console.error("getPost", e);
    res.status(500).json({ success: false, message: e.message });
  }
}

/**
 * How many times each tracked account has opened one post.
 *
 * LEFT JOINed from [tracked_viewers] outwards so an account that has never
 * viewed the post still appears, with zero — "has this person read it yet?"
 * is the question this answers, and an absent row would read as a loading
 * gap rather than a no.
 */
async function trackedBreakdown(postId) {
  const { rows } = await pool.query(
    `SELECT t.id, t.email, t.label,
            COUNT(v.id)::int AS views,
            MAX(v.viewed_at) AS last_viewed_at,
            (u.id IS NOT NULL) AS has_account
       FROM tracked_viewers t
       LEFT JOIN users u ON LOWER(u.email) = t.email
       LEFT JOIN on_this_day_views v ON v.user_id = u.id AND v.post_id = $1
      GROUP BY t.id, t.email, t.label, u.id
      ORDER BY COUNT(v.id) DESC, t.email`,
    [postId],
  );
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    label: r.label ?? null,
    views: r.views ?? 0,
    lastViewedAt: r.last_viewed_at,
    hasAccount: r.has_account === true,
  }));
}

/** POST /api/on-this-day — admin creates post + triggers push notification */
export async function createPost(req, res) {
  if (!(await requireAdmin(req, res))) return;
  try {
    const { title, description, imagePath } = req.body;
    if (!title?.trim())
      return res
        .status(400)
        .json({ success: false, message: "title required" });

    const { rows } = await pool.query(
      `INSERT INTO on_this_day (title, description, image_path, created_by_user_id)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [title.trim(), description ?? null, imagePath ?? null, req.userId],
    );
    const post = rowToJson(rows[0], req);

    // Fire push notification to all subscribers
    const notifBody = description
      ? description.substring(0, 100) + (description.length > 100 ? "…" : "")
      : "Tap to read more";

    const fcmResult = await pushGlobalEvent({
      title: `Today in History: ${title.trim()}`,
      body: notifBody,
      eventId: String(post.id),
      extraData: { type: "on_this_day", postId: String(post.id) },
    });

    res.status(201).json({ success: true, post, fcm: fcmResult });
  } catch (e) {
    console.error("createPost", e);
    res.status(500).json({ success: false, message: e.message });
  }
}

/** PUT /api/on-this-day/:id — admin updates (no re-notification) */
export async function updatePost(req, res) {
  if (!(await requireAdmin(req, res))) return;
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
      return res.status(404).json({ success: false, message: "Not found" });
    res.json({ success: true, post: rowToJson(rows[0], req) });
  } catch (e) {
    console.error("updatePost", e);
    res.status(500).json({ success: false, message: e.message });
  }
}

/** DELETE /api/on-this-day/:id */
export async function deletePost(req, res) {
  if (!(await requireAdmin(req, res))) return;
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM on_this_day WHERE id = $1`,
      [req.params.id],
    );
    if (!rowCount)
      return res.status(404).json({ success: false, message: "Not found" });
    res.json({ success: true });
  } catch (e) {
    console.error("deletePost", e);
    res.status(500).json({ success: false, message: e.message });
  }
}


/**
 * POST /api/on-this-day/:id/view — records that someone opened a post.
 *
 * Deliberately its own call rather than a side effect of GET /:id, so that a
 * list render, a prefetch or an admin editing a post does not inflate the
 * number. Open to signed-out devices; an unknown id is a no-op rather than an
 * error, because the app fires this in the background and must never show the
 * reader a failure for it.
 */
export async function recordView(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.json({ success: true });
  }
  try {
    await pool.query(
      `INSERT INTO on_this_day_views (post_id, user_id)
       SELECT $1, $2 WHERE EXISTS (SELECT 1 FROM on_this_day WHERE id = $1)`,
      [id, req.userId ?? null],
    );
  } catch (e) {
    console.error('recordView', e.message);
  }
  return res.json({ success: true });
}

// ─── Tracked viewers ─────────────────────────────────────────────────────────

const MAX_TRACKED = 25;
const MAX_LABEL = 120;

/**
 * Deliberately permissive — this only decides whose views get counted
 * separately, so a typo costs a zero, not access to anything.
 */
function normaliseEmail(raw) {
  const email = String(raw ?? "").trim().toLowerCase();
  if (!email) return { error: "Enter an email address" };
  if (email.length > 255) return { error: "That email is too long" };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { error: "That does not look like an email address" };
  }
  return { email };
}

/** GET /api/on-this-day/tracked — admin only */
export async function listTrackedViewers(req, res) {
  if (!(await requireAdmin(req, res))) return;
  try {
    const { rows } = await pool.query(
      `SELECT t.id, t.email, t.label, t.created_at,
              (u.id IS NOT NULL) AS has_account
         FROM tracked_viewers t
         LEFT JOIN users u ON LOWER(u.email) = t.email
        ORDER BY t.created_at DESC`,
    );
    res.json({
      success: true,
      viewers: rows.map((r) => ({
        id: r.id,
        email: r.email,
        label: r.label ?? null,
        hasAccount: r.has_account === true,
        createdAt: r.created_at,
      })),
    });
  } catch (e) {
    console.error("listTrackedViewers", e);
    res.status(500).json({ success: false, message: e.message });
  }
}

/** POST /api/on-this-day/tracked — admin only. Body: { email, label? } */
export async function addTrackedViewer(req, res) {
  if (!(await requireAdmin(req, res))) return;
  const { email, error } = normaliseEmail(req.body?.email);
  if (error) return res.status(400).json({ success: false, message: error });

  const label = String(req.body?.label ?? "").trim().slice(0, MAX_LABEL) || null;

  try {
    const { rows: existing } = await pool.query(
      "SELECT COUNT(*)::int AS n FROM tracked_viewers",
    );
    if (existing[0].n >= MAX_TRACKED) {
      return res.status(400).json({
        success: false,
        message: `You can track at most ${MAX_TRACKED} accounts`,
      });
    }

    // ON CONFLICT rather than a pre-check: two admins adding the same email at
    // once would both pass a check and one would then hit the unique index.
    const { rows } = await pool.query(
      `INSERT INTO tracked_viewers (email, label, added_by_user_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (email) DO UPDATE SET label = COALESCE(EXCLUDED.label, tracked_viewers.label)
       RETURNING id, email, label, created_at`,
      [email, label, req.userId],
    );
    const row = rows[0];
    const { rows: acct } = await pool.query(
      "SELECT id FROM users WHERE LOWER(email) = $1",
      [email],
    );
    res.json({
      success: true,
      viewer: {
        id: row.id,
        email: row.email,
        label: row.label ?? null,
        hasAccount: acct.length > 0,
        createdAt: row.created_at,
      },
    });
  } catch (e) {
    console.error("addTrackedViewer", e);
    res.status(500).json({ success: false, message: e.message });
  }
}

/** DELETE /api/on-this-day/tracked/:id — admin only */
export async function removeTrackedViewer(req, res) {
  if (!(await requireAdmin(req, res))) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ success: false, message: "Bad id" });
  }
  try {
    // The view rows are left alone — they are the record of what happened, and
    // removing an email only stops it being counted separately from now on.
    await pool.query("DELETE FROM tracked_viewers WHERE id = $1", [id]);
    res.json({ success: true });
  } catch (e) {
    console.error("removeTrackedViewer", e);
    res.status(500).json({ success: false, message: e.message });
  }
}
