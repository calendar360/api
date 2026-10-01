import pool from '../db/pool.js';

/**
 * Meetings are free for the first few meetings a user actually schedules,
 * then require a subscription.
 *
 * This replaced a 30-day free trial. A time window expired whether or not the
 * user ever tried the feature — most never opened it inside the window and so
 * met a paywall having had nothing. A use count cannot be missed: the free
 * allowance is still there whenever they get round to it.
 */
export const FREE_MEETING_USES = 3;

/**
 * Computes whether a user has meetings access.
 *
 * Returns { active, expiresAt, isFree, freeUsesLeft, freeUsesTotal }.
 * `isFree` means "this access is coming from the free allowance", which is
 * what tells the app to warn that creating a meeting spends one.
 */
export function computeMeetingsAccess(user) {
  const now = new Date();

  let sub = {};
  try {
    sub =
      typeof user.meetings_sub === 'string'
        ? JSON.parse(user.meetings_sub)
        : user.meetings_sub || {};
  } catch (_) {}

  const subExpiry =
    sub.status === 'active' && sub.expiresAt ? new Date(sub.expiresAt) : null;

  const used = Number(user.meetings_free_used) || 0;
  const freeUsesLeft = Math.max(0, FREE_MEETING_USES - used);

  // Paid access is checked first, so a subscriber never spends a free use and
  // keeps the remaining ones if the subscription later lapses.
  if (subExpiry && subExpiry > now) {
    return {
      active: true,
      expiresAt: sub.expiresAt,
      isFree: false,
      freeUsesLeft,
      freeUsesTotal: FREE_MEETING_USES,
    };
  }

  if (freeUsesLeft > 0) {
    return {
      active: true,
      expiresAt: null,
      isFree: true,
      freeUsesLeft,
      freeUsesTotal: FREE_MEETING_USES,
    };
  }

  return {
    active: false,
    expiresAt: null,
    isFree: false,
    freeUsesLeft: 0,
    freeUsesTotal: FREE_MEETING_USES,
  };
}

/**
 * Spends one free use, atomically.
 *
 * The `meetings_free_used < $2` guard is what makes this safe against two
 * concurrent requests both reading "1 use left" and both being allowed
 * through — the second UPDATE matches no row.
 *
 * Returns the number of free uses left afterwards, or null when there were
 * none to spend.
 */
export async function consumeFreeMeetingUse(userId) {
  const res = await pool.query(
    `UPDATE users SET meetings_free_used = meetings_free_used + 1
      WHERE id = $1 AND meetings_free_used < $2
      RETURNING meetings_free_used`,
    [userId, FREE_MEETING_USES],
  );
  if (!res.rows.length) return null;
  return Math.max(0, FREE_MEETING_USES - Number(res.rows[0].meetings_free_used));
}

/**
 * Gives back a use spent by [consumeFreeMeetingUse] when the meeting it was
 * spent on failed to save. Clamped at zero so a double refund cannot mint
 * extra free meetings.
 */
export async function refundFreeMeetingUse(userId) {
  try {
    await pool.query(
      `UPDATE users SET meetings_free_used = GREATEST(0, meetings_free_used - 1)
        WHERE id = $1`,
      [userId],
    );
  } catch (e) {
    console.error('[meetings] refundFreeMeetingUse:', e);
  }
}
