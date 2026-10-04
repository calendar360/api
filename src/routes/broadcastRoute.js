import express from 'express';
import { authRequired } from '../middleware/auth.js';
import { adminRequired } from '../middleware/requireAdmin.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { sendBroadcast } from '../controllers/broadcastController.js';

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

export default router;
