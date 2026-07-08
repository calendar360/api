import express from 'express';
import { authRequired } from '../middleware/auth.js';
import {
  initMarqueeAdPayment,
  initPremiumPayment,
  handleEspeesSuccess,
  handleEspeesFailure,
  handleEspeesWebhook,
  handlePremiumSuccess,
  handlePremiumFailure,
  getAdPaymentStatus,
  initMeetingsSubscription,
  handleMeetingsSubSuccess,
  handleMeetingsSubFailure,
  getMeetingsSubStatus,
} from '../controllers/paymentController.js';

const router = express.Router();

router.post('/espees/init', authRequired, initMarqueeAdPayment);
router.get('/espees/success', handleEspeesSuccess);
router.get('/espees/failed', handleEspeesFailure);
router.post('/espees/webhook', handleEspeesWebhook);
router.post('/premium/init', authRequired, initPremiumPayment);
router.get('/premium/success', authRequired, handlePremiumSuccess);
router.get('/premium/failed', authRequired, handlePremiumFailure);
router.get('/ad-status/:adId', authRequired, getAdPaymentStatus);

router.post('/meetings-sub/init', authRequired, initMeetingsSubscription);
router.get('/meetings-sub/success', authRequired, handleMeetingsSubSuccess);
router.get('/meetings-sub/failed', handleMeetingsSubFailure);
router.get('/meetings-sub/status', authRequired, getMeetingsSubStatus);

export default router;
