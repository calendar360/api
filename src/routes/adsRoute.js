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
} from '../controllers/adsController.js';
import { authOptional, authRequired } from '../middleware/auth.js';
import { adminRequired } from '../middleware/requireAdmin.js';

const router = express.Router();

router.get('/active', authOptional, listActiveAds);
router.get('/mine', authRequired, listMyAds);

// Admin approval queue. Declared before '/:id' so these literal paths are not
// swallowed by the parameterised route below.
router.get('/pending-approval', authRequired, adminRequired, listPendingApproval);
router.get('/pending-count', authRequired, adminRequired, pendingApprovalCount);
router.post('/:id/approve', authRequired, adminRequired, approveAd);
router.post('/:id/reject', authRequired, adminRequired, rejectAd);

router.post('/', authRequired, createPendingAd);
router.delete('/pending/:id', authRequired, cancelPendingAd);
router.delete('/:id', authRequired, deleteAd);

export default router;
