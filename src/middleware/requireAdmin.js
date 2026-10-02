import pool from '../db/pool.js';

/**
 * Route guard for admin-only endpoints. Runs after [authRequired], which is
 * what sets req.userId.
 *
 * The flag is read from the database on each request rather than carried in
 * the JWT, so revoking admin takes effect immediately instead of whenever the
 * user's token happens to expire.
 */
export const adminRequired = async (req, res, next) => {
  if (!req.userId) {
    return res.status(401).json({ success: false, message: 'Not authorized' });
  }
  try {
    const { rows } = await pool.query('SELECT is_admin FROM users WHERE id = $1', [
      req.userId,
    ]);
    if (!rows[0]?.is_admin) {
      return res.status(403).json({ success: false, message: 'Admin only' });
    }
    req.isAdmin = true;
    next();
  } catch (e) {
    console.error('[auth] adminRequired:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

/**
 * Non-blocking variant: sets req.isAdmin and continues either way.
 *
 * For endpoints that only *widen* what an admin may do — the blog feed also
 * lists drafts, and comment deletion also allows moderating other people's
 * comments — rather than refusing everyone else.
 */
export const adminFlag = async (req, res, next) => {
  req.isAdmin = false;
  if (!req.userId) return next();
  try {
    const { rows } = await pool.query('SELECT is_admin FROM users WHERE id = $1', [
      req.userId,
    ]);
    req.isAdmin = rows[0]?.is_admin === true;
  } catch (e) {
    // Treated as "not an admin" — a failed lookup must not hand out rights.
    console.error('[auth] adminFlag:', e);
  }
  next();
};
