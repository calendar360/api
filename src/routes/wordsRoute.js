import express from 'express';
import { listWords, upsertWord } from '../controllers/wordsController.js';
import { authOptional, authRequired } from '../middleware/auth.js';

const router = express.Router();

router.get('/', authOptional, listWords);
router.put('/:id', authRequired, upsertWord);

export default router;
