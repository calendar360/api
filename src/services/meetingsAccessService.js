const FREE_TRIAL_DAYS = 30;

/**
 * Computes whether a user has active meetings access.
 * Active if:
 *   - Still within the 30-day free trial from account creation, OR
 *   - Has a paid subscription that has not expired.
 *
 * Returns { active, expiresAt (ISO string | null), isFree }
 */
export function computeMeetingsAccess(user) {
  const now = new Date();

  // Free trial window
  const createdAt = user.created_at ? new Date(user.created_at) : null;
  const freeUntil = createdAt
    ? new Date(createdAt.getTime() + FREE_TRIAL_DAYS * 24 * 60 * 60 * 1000)
    : null;

  if (freeUntil && now < freeUntil) {
    return { active: true, expiresAt: freeUntil.toISOString(), isFree: true };
  }

  // Paid subscription
  let sub = {};
  try {
    sub =
      typeof user.meetings_sub === 'string'
        ? JSON.parse(user.meetings_sub)
        : user.meetings_sub || {};
  } catch (_) {}

  const subExpiry =
    sub.status === 'active' && sub.expiresAt ? new Date(sub.expiresAt) : null;

  if (subExpiry && subExpiry > now) {
    return { active: true, expiresAt: sub.expiresAt, isFree: false };
  }

  return { active: false, expiresAt: null, isFree: false };
}
