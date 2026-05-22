import express from 'express';
import { authRequired } from '../middleware/auth.js';
import {
  initMarqueeAdPayment,
  handleEspeesSuccess,
  handleEspeesFailure,
  handleEspeesWebhook,
  getAdPaymentStatus,
} from '../controllers/paymentController.js';

const router = express.Router();

router.post('/espees/init', authRequired, initMarqueeAdPayment);
router.get('/espees/success', handleEspeesSuccess);
router.get('/espees/failed', handleEspeesFailure);
router.post('/espees/webhook', handleEspeesWebhook);
router.get('/ad-status/:adId', authRequired, getAdPaymentStatus);

export default router;
