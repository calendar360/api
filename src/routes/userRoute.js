import express from 'express';
import {
  kingschatLogin,
  kingschatProfileLogin,
  getMe,
  registerFcmToken,
  syncUser,
  updateBirthday,
  clearBirthday,
  getKingsChatProfile,
} from '../controllers/userController.js';
import { authRequired } from '../middleware/auth.js';

const router = express.Router();

router.post('/sync', syncUser);
router.post('/kingschat', kingschatLogin);
router.post('/kingschat-profile', kingschatProfileLogin);
router.get('/me', authRequired, getMe);
router.post('/fcm-token', authRequired, registerFcmToken);
router.patch('/birthday', authRequired, updateBirthday);
router.delete('/birthday', authRequired, clearBirthday);
router.get('/kingschat-profile', authRequired, getKingsChatProfile);

export default router;
