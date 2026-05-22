import express from 'express';
import {
  kingschatLogin,
  kingschatProfileLogin,
  getMe,
  registerFcmToken,
  syncUser,
} from '../controllers/userController.js';
import { authRequired } from '../middleware/auth.js';

const router = express.Router();

router.post('/sync', syncUser);
router.post('/kingschat', kingschatLogin);
router.post('/kingschat-profile', kingschatProfileLogin);
router.get('/me', authRequired, getMe);
router.post('/fcm-token', authRequired, registerFcmToken);

export default router;
