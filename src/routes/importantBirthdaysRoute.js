import express from 'express';
import { listImportantBirthdays } from '../controllers/eventsController.js';
import { authOptional } from '../middleware/auth.js';

const router = express.Router();

router.get('/', authOptional, listImportantBirthdays);

export default router;
