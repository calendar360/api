import express from 'express';
import {
  listActiveAds,
  listMyAds,
  createPendingAd,
  deleteAd,
  cancelPendingAd,
  listPendingApproval,
  pendingApprovalCount,
  approveAd,
  rejectAd,
  serveAdImage,
} from '../controllers/adsController.js';
import { authOptional, authRequired } from '../middleware/auth.js';
import { adminRequired, adminFlag } from '../middleware/requireAdmin.js';
import { rateLimit } from '../middleware/rateLimit.js';

const router = express.Router();

router.get('/active', authOptional, listActiveAds);
router.get('/mine', authRequired, listMyAds);

// Admin approval queue. Declared before the parameterised routes so these
// literal paths are not swallowed by '/:id/...'.
router.get('/pending-approval', authRequired, adminRequired, listPendingApproval);
router.get('/pending-count', authRequired, adminRequired, pendingApprovalCount);

// Advert artwork. The only reader of the private advert upload directory —
// public for a live advert, otherwise owner, admin or signed token only.
// authOptional + adminFlag because it must answer for signed-out visitors too.
router.get('/:id/image', authOptional, adminFlag, serveAdImage);

router.post('/:id/approve', authRequired, adminRequired, approveAd);
router.post('/:id/reject', authRequired, adminRequired, rejectAd);

// Submitting is free now, so the charge no longer limits it. The per-user cap
// in createPendingAd bounds how many can sit in the queue at once; this bounds
// the churn of submit-withdraw-submit on top of that.
router.post(
  '/',
  authRequired,
  rateLimit({ max: 10, windowMs: 60 * 60 * 1000, name: 'advert-submit' }),
  createPendingAd,
);
router.delete('/pending/:id', authRequired, cancelPendingAd);
router.delete('/:id', authRequired, deleteAd);

export default router;
