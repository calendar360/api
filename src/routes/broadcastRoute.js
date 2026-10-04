import express from 'express';
import { authRequired, authOptional } from '../middleware/auth.js';
import { adminRequired } from '../middleware/requireAdmin.js';
import { rateLimit } from '../middleware/rateLimit.js';
import {
  sendBroadcast,
  listBroadcasts,
  recordBroadcastClick,
} from '../controllers/broadcastController.js';

const router = express.Router();

// Every send reaches every device, so a slip of the finger is expensive and
// irreversible. Admin-only, and capped per account per hour.
router.post(
  '/',
  authRequired,
  adminRequired,
  rateLimit({ max: 10, windowMs: 60 * 60 * 1000, name: 'broadcast' }),
  sendBroadcast,
);

// History is admin-only; the click report is the point of it.
router.get('/', authRequired, adminRequired, listBroadcasts);

// Open to signed-out devices — see recordBroadcastClick. Rate limited so a
// single device cannot inflate the number it reports.
router.post(
  '/:id/click',
  authOptional,
  rateLimit({ max: 60, windowMs: 60 * 60 * 1000, name: 'broadcast-click' }),
  recordBroadcastClick,
);

export default router;
