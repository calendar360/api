import fs from 'fs/promises';
import path from 'path';
import pool from '../db/pool.js';
import { advertUploadsDir } from '../routes/advertUploadRoute.js';

/**
 * Housekeeping for advert artwork.
 *
 * Nothing used to delete an uploaded file, ever. A rejected advert's image sat
 * on disk permanently, and because submitting is now free there was no cost at
 * all to uploading until the volume ran out of space.
 */

/** Files this old with no advert pointing at them are abandoned uploads. */
const ORPHAN_AGE_MS = 24 * 60 * 60 * 1000;

/** How often the sweep runs once started. */
const SWEEP_EVERY_MS = 6 * 60 * 60 * 1000;

/**
 * Deletes the artwork for an advert that has reached a terminal state.
 *
 * `image_path` is deliberately left on the row: the filename stays as a record
 * of what was submitted, and [serveAdImage] simply answers 404 once the file
 * is gone.
 */
export async function deleteAdvertImage(ad) {
  if (!ad?.image_path) return false;
  const name = path.basename(ad.image_path);

  // Two adverts can name the same upload if one was resubmitted, so only
  // remove the file when no surviving advert still needs it.
  try {
    const { rows } = await pool.query(
      `SELECT 1 FROM advertisements
        WHERE image_path = $1
          AND id <> $2
          AND status NOT IN ('rejected', 'cancelled')
        LIMIT 1`,
      [ad.image_path, ad.id],
    );
    if (rows.length) return false;
  } catch (e) {
    // A failed check must not delete a file that might still be in use.
    console.error('[ads] deleteAdvertImage check failed:', e.message);
    return false;
  }

  try {
    await fs.unlink(path.join(advertUploadsDir, name));
    console.log('[ads] removed artwork for advert', ad.id, '->', name);
    return true;
  } catch (e) {
    // Already gone, or it lives in the legacy public directory, which is
    // shared with other features and must not be touched from here.
    if (e.code !== 'ENOENT') {
      console.error('[ads] deleteAdvertImage failed:', e.message);
    }
    return false;
  }
}

/**
 * Removes uploads that no advert ever claimed.
 *
 * Artwork is uploaded before the advert row exists, so anyone can call the
 * upload endpoint and walk away. The age threshold keeps this clear of a file
 * that was just uploaded and is seconds away from being attached.
 */
export async function sweepOrphanedAdvertImages() {
  let names;
  try {
    names = await fs.readdir(advertUploadsDir);
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[ads] sweep readdir failed:', e.message);
    return { removed: 0, kept: 0 };
  }
  if (!names.length) return { removed: 0, kept: 0 };

  let referenced = new Set();
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT image_path FROM advertisements WHERE image_path IS NOT NULL`,
    );
    referenced = new Set(rows.map((r) => path.basename(r.image_path)));
  } catch (e) {
    // Without the reference list every file would look orphaned, so stop.
    console.error('[ads] sweep skipped, could not read adverts:', e.message);
    return { removed: 0, kept: names.length };
  }

  const cutoff = Date.now() - ORPHAN_AGE_MS;
  let removed = 0;
  let kept = 0;

  for (const name of names) {
    if (referenced.has(name)) {
      kept += 1;
      continue;
    }
    const full = path.join(advertUploadsDir, name);
    try {
      const stat = await fs.stat(full);
      if (stat.mtimeMs > cutoff) {
        kept += 1;
        continue;
      }
      await fs.unlink(full);
      removed += 1;
    } catch (e) {
      if (e.code !== 'ENOENT') console.error('[ads] sweep unlink failed:', e.message);
    }
  }

  if (removed) console.log(`[ads] sweep removed ${removed} orphaned upload(s)`);
  return { removed, kept };
}

/** Runs the sweep now and then every few hours. */
export function startAdvertImageSweeper() {
  sweepOrphanedAdvertImages().catch((e) =>
    console.error('[ads] initial sweep failed:', e.message),
  );
  const timer = setInterval(() => {
    sweepOrphanedAdvertImages().catch((e) =>
      console.error('[ads] sweep failed:', e.message),
    );
  }, SWEEP_EVERY_MS);
  // Does not hold the process open on shutdown.
  timer.unref?.();
  return timer;
}
