/**
 * Grant, extend or revoke meetings access for a specific account —
 * the equivalent of scripts/set-paid.js, but for the meetings subscription.
 *
 * Usage:
 *   node scripts/grant-meetings.js <email|username|id> [command]
 *
 * Commands:
 *   status        show current access, change nothing
 *   1m 3m 6m 12m  grant that many months (default: 12m)
 *   30d           grant that many days
 *   lifetime      grant access that does not expire
 *   revoke        remove granted access
 *   reset-free    give back the free meeting allowance
 *
 * Examples:
 *   node scripts/grant-meetings.js pastor@example.com lifetime
 *   node scripts/grant-meetings.js davidudoji 12m
 *   node scripts/grant-meetings.js 42 status
 *   node scripts/grant-meetings.js 42 revoke
 *
 * Inside Docker:
 *   docker exec -it cal360api node scripts/grant-meetings.js <who> 12m
 *
 * Uses the pg pool rather than Prisma: the committed Prisma schema has drifted
 * from the database (it does not know meetings_free_used, and a locally
 * generated client may not know meetings_sub either), whereas every runtime
 * path already goes through pg.
 */
import 'dotenv/config';
import { fileURLToPath } from 'url';
import pool from '../src/db/pool.js';
import {
  computeMeetingsAccess,
  FREE_MEETING_USES,
} from '../src/services/meetingsAccessService.js';

/** Far enough out to mean "never expires" without special-casing the reader. */
const LIFETIME_EXPIRY = new Date('2999-12-31T00:00:00.000Z');

/**
 * Turns a command into { months, days, label }, or null when it is not a
 * duration. Months are calendar months rather than 30-day blocks, so "12m"
 * really is a year instead of 360 days. Exported for testing.
 */
export function parseDuration(cmd) {
  if (cmd === 'lifetime') return { months: null, days: null, label: 'lifetime' };
  const m = /^(\d+)(m|d)$/.exec(cmd || '');
  if (!m) return null;
  const n = Number(m[1]);
  if (!n || n > 1200) return null;
  return m[2] === 'm'
    ? { months: n, days: null, label: `${n} month${n === 1 ? '' : 's'}` }
    : { months: null, days: n, label: `${n} day${n === 1 ? '' : 's'}` };
}

/** Advances [from] by a duration, by calendar month or by whole days. */
function addDuration(from, duration) {
  const out = new Date(from.getTime());
  if (duration.months !== null) {
    out.setUTCMonth(out.getUTCMonth() + duration.months);
  } else {
    out.setUTCDate(out.getUTCDate() + duration.days);
  }
  return out;
}

/**
 * Builds the meetings_sub payload for a grant.
 *
 * Extends from the current expiry when access is still live, so granting twice
 * adds time rather than cutting it short — the same rule the real payment
 * callback uses. `source` marks this as a comped account so it can be told
 * apart from genuine revenue, and no `confirmation` block is written because
 * no payment was taken.
 *
 * Exported for testing.
 */
export function buildGrant(existingSub, duration, now = new Date()) {
  if (duration.label === 'lifetime') {
    return {
      status: 'active',
      plan: 'lifetime',
      source: 'admin_grant',
      activatedAt: now.toISOString(),
      expiresAt: LIFETIME_EXPIRY.toISOString(),
    };
  }

  const currentExpiry = existingSub?.expiresAt ? new Date(existingSub.expiresAt) : null;
  const stillActive =
    existingSub?.status === 'active' && currentExpiry && currentExpiry > now;
  const base = stillActive ? currentExpiry : now;

  return {
    status: 'active',
    plan: duration.label,
    source: 'admin_grant',
    activatedAt: now.toISOString(),
    expiresAt: addDuration(base, duration).toISOString(),
    extendedFrom: stillActive ? currentExpiry.toISOString() : null,
  };
}

function parseSub(raw) {
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw || {};
  } catch (_) {
    return {};
  }
}

function describe(user) {
  const a = computeMeetingsAccess(user);
  const sub = parseSub(user.meetings_sub);
  const until = a.expiresAt ? new Date(a.expiresAt) : null;
  const untilLabel =
    until && until.getUTCFullYear() > 2900
      ? 'never expires'
      : until
        ? `until ${until.toISOString().slice(0, 10)}`
        : 'no expiry';

  if (!a.active) return `no access (free uses spent, no live subscription)`;
  if (a.isFree) return `free tier — ${a.freeUsesLeft} of ${a.freeUsesTotal} meetings left`;
  return `subscribed (${sub.plan || 'unknown plan'}${
    sub.source === 'admin_grant' ? ', admin grant' : ''
  }) ${untilLabel}`;
}

/** Resolves an identifier to exactly one user row, or exits with guidance. */
async function findUser(who) {
  const asId = /^#?(\d+)$/.exec(who);
  const { rows } = asId
    ? await pool.query(
        `SELECT id, email, username, first_name, last_name, meetings_sub, meetings_free_used
           FROM users WHERE id = $1`,
        [Number(asId[1])],
      )
    : await pool.query(
        `SELECT id, email, username, first_name, last_name, meetings_sub, meetings_free_used
           FROM users
          WHERE LOWER(email) = LOWER($1) OR LOWER(username) = LOWER($1)
          ORDER BY id`,
        [who],
      );

  if (!rows.length) {
    console.error(`No user matches "${who}" by id, email or username.`);
    process.exit(1);
  }
  if (rows.length > 1) {
    // username has no UNIQUE constraint, so this is reachable.
    console.error(`"${who}" matches ${rows.length} accounts — re-run with the id:`);
    for (const r of rows) {
      console.error(`  ${r.id}  ${r.email}  @${r.username || '-'}  ${r.first_name || ''} ${r.last_name || ''}`.trimEnd());
    }
    process.exit(1);
  }
  return rows[0];
}

async function main() {
  const who = process.argv[2];
  const cmd = (process.argv[3] || '12m').toLowerCase();

  if (!who) {
    console.error('Usage: node scripts/grant-meetings.js <email|username|id> [status|1m|12m|30d|lifetime|revoke|reset-free]');
    process.exit(1);
  }

  const user = await findUser(who);
  const name = `${user.first_name || ''} ${user.last_name || ''}`.trim();
  console.log(
    `User ${user.id}: ${name ? `${name} ` : ''}<${user.email}> @${user.username || '-'}`,
  );
  console.log(`  before: ${describe(user)}`);

  if (cmd === 'status') return;

  if (cmd === 'reset-free') {
    await pool.query('UPDATE users SET meetings_free_used = 0 WHERE id = $1', [user.id]);
    console.log(`  after:  free allowance restored to ${FREE_MEETING_USES} meetings`);
    return;
  }

  if (cmd === 'revoke') {
    const sub = parseSub(user.meetings_sub);
    if (sub.status !== 'active') {
      console.log('  after:  nothing to revoke (no active subscription)');
      return;
    }
    // Kept rather than nulled so the history of the grant survives.
    const revoked = { ...sub, status: 'revoked', revokedAt: new Date().toISOString() };
    await pool.query('UPDATE users SET meetings_sub = $1 WHERE id = $2', [
      JSON.stringify(revoked), user.id,
    ]);
    const after = await findUser(String(user.id));
    console.log(`  after:  ${describe(after)}`);
    return;
  }

  const duration = parseDuration(cmd);
  if (!duration) {
    console.error(`Unknown command "${cmd}". Use status, 1m, 3m, 12m, 30d, lifetime, revoke or reset-free.`);
    process.exit(1);
  }

  const grant = buildGrant(parseSub(user.meetings_sub), duration);
  await pool.query('UPDATE users SET meetings_sub = $1 WHERE id = $2', [
    JSON.stringify(grant), user.id,
  ]);

  const after = await findUser(String(user.id));
  console.log(`  after:  ${describe(after)}`);
  if (grant.extendedFrom) {
    console.log(`  (extended from the existing expiry, not restarted)`);
  }
  console.log('Granted. The account picks this up on its next /me call.');
}

// Only when run directly, so parseDuration/buildGrant can be imported and
// tested without opening a connection.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
    .catch((e) => {
      console.error(e.message);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
