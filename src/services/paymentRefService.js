import crypto from 'crypto';
import { tokenSecret } from '../middleware/auth.js';

/**
 * Signs and verifies the identity carried in an Espees return URL.
 *
 * Why this exists: a success/failure callback is reached by a *redirect* from
 * the payment provider inside a WebView. A redirect cannot set the `token`
 * header that `authRequired` reads, so putting `authRequired` on those routes
 * made them answer 401 and the purchase was never recorded. The user paid and
 * got nothing.
 *
 * So the return URL carries the user id plus an HMAC over it. The id is
 * readable but not forgeable, which is all the callback needs — it never
 * trusts the amount or the outcome from the query string, only the identity.
 * The payment itself is still verified server-to-server against Espees.
 */

/** HMAC over the fields that must not be tampered with. */
function signature(kind, userId, plan) {
  return crypto
    .createHmac('sha256', tokenSecret())
    .update(`${kind}:${userId}:${plan || ''}`)
    .digest('hex');
}

/** Query string (no leading `?`) identifying [userId] for a [kind] purchase. */
export function signedRefQuery(kind, userId, plan) {
  const params = new URLSearchParams({
    uid: String(userId),
    sig: signature(kind, userId, plan),
  });
  if (plan) params.set('plan', plan);
  return params.toString();
}

/**
 * Returns the user id a return URL legitimately refers to, or null when the
 * signature is missing or does not match. [plan] must be the value the caller
 * has already normalised, so a tampered plan fails the check.
 */
export function verifiedUserId(kind, query, plan) {
  const uid = Number(query?.uid);
  const sig = query?.sig;
  if (!Number.isInteger(uid) || uid <= 0 || typeof sig !== 'string') return null;

  const expected = signature(kind, uid, plan);
  // Both are hex digests of equal length, so a length mismatch means a forgery
  // rather than a buffer error — timingSafeEqual would throw on it.
  if (sig.length !== expected.length) return null;
  const ok = crypto.timingSafeEqual(Buffer.from(sig, 'utf8'), Buffer.from(expected, 'utf8'));
  return ok ? uid : null;
}

// ── Adverts ─────────────────────────────────────────────────────────────────

/**
 * Advert return URLs sign the advert id as well as the user.
 *
 * The ads callback used to carry a bare `?adId=5`, so anyone could name any
 * advert. Binding both values into one HMAC means a caller cannot swap the
 * advert, the user, or either one independently.
 *
 * This proves *who* the callback is about. It does not prove payment — that is
 * confirmed server-to-server against Espees before an advert goes live, which
 * is what stops a user replaying their own legitimately signed URL.
 */
export function signedAdRefQuery(userId, adId) {
  return new URLSearchParams({
    uid: String(userId),
    ad: String(adId),
    sig: signature('ad', userId, String(adId)),
  }).toString();
}

/** { userId, adId } when the signature matches, else null. */
export function verifiedAdRef(query) {
  const uid = Number(query?.uid);
  const adId = Number(query?.ad);
  const sig = query?.sig;
  if (!Number.isInteger(uid) || uid <= 0) return null;
  if (!Number.isInteger(adId) || adId <= 0) return null;
  if (typeof sig !== 'string') return null;

  const expected = signature('ad', uid, String(adId));
  if (sig.length !== expected.length) return null;
  const ok = crypto.timingSafeEqual(
    Buffer.from(sig, 'utf8'),
    Buffer.from(expected, 'utf8'),
  );
  return ok ? { userId: uid, adId } : null;
}

/**
 * Read token for one advert's image, handed out only to the owner and admins.
 *
 * Advert images live outside the public uploads directory now, so a pending or
 * rejected advert's artwork is not world-readable. An approved advert's image
 * needs no token: it is in the marquee, which anyone can see.
 *
 * Scoped to a single advert id, so it cannot be used to read another's. It
 * does not expire — if one leaks it exposes that one image, which is a far
 * smaller surface than the whole uploads directory being public.
 */
export function adImageToken(adId) {
  return crypto
    .createHmac('sha256', tokenSecret())
    .update(`adimg:${adId}`)
    .digest('hex')
    .slice(0, 32);
}

export function verifyAdImageToken(adId, token) {
  const expected = adImageToken(adId);
  if (typeof token !== 'string' || token.length !== expected.length) return false;
  return crypto.timingSafeEqual(
    Buffer.from(token, 'utf8'),
    Buffer.from(expected, 'utf8'),
  );
}
