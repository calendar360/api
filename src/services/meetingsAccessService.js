const FREE_TRIAL_DAYS = 30;

// All users — new and existing — receive 30 free days from this date.
// Existing accounts whose created_at predates this get a trial starting here.
const FEATURE_LAUNCH_DATE = new Date('2026-07-08T00:00:00.000Z');

/**
 * Computes whether a user has active meetings access.
 * Active if:
 *   - Still within the 30-day free trial (starts from the later of
 *     account creation date or FEATURE_LAUNCH_DATE), OR
 *   - Has a paid subscription that has not expired.
 *
 * Returns { active, expiresAt (ISO string | null), isFree }
 */
export function computeMeetingsAccess(user) {
  const now = new Date();

  // Free trial: trial clock starts from whichever is later — account creation
  // or feature launch — so every user always gets a full 30 free days.
  const createdAt = user.created_at ? new Date(user.created_at) : FEATURE_LAUNCH_DATE;
  const trialStart = createdAt > FEATURE_LAUNCH_DATE ? createdAt : FEATURE_LAUNCH_DATE;
  const freeUntil = new Date(trialStart.getTime() + FREE_TRIAL_DAYS * 24 * 60 * 60 * 1000);

  if (now < freeUntil) {
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
