import express from 'express';
import { getAppSettings, setBirthdayBanner } from '../controllers/appSettingsController.js';
import { authRequired } from '../middleware/auth.js';

const router = express.Router();

router.get('/', getAppSettings);
router.put('/birthday-banner', authRequired, setBirthdayBanner);

export default router;
