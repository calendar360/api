import express from 'express';
import {
  listActiveAds,
  listMyAds,
  createPendingAd,
  deleteAd,
  cancelPendingAd,
} from '../controllers/adsController.js';
import { authOptional, authRequired } from '../middleware/auth.js';

const router = express.Router();

router.get('/active', authOptional, listActiveAds);
router.get('/mine', authRequired, listMyAds);
router.post('/', authRequired, createPendingAd);
router.delete('/pending/:id', authRequired, cancelPendingAd);
router.delete('/:id', authRequired, deleteAd);

export default router;
