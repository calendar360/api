import express from 'express';
import { authRequired, authOptional } from '../middleware/auth.js';
import {
  listThemes,
  getTheme,
  createTheme,
  updateTheme,
  deleteTheme,
} from '../controllers/themesController.js';

const router = express.Router();

router.get('/', authOptional, listThemes);
router.get('/:id', authOptional, getTheme);
router.post('/', authRequired, createTheme);
router.put('/:id', authRequired, updateTheme);
router.delete('/:id', authRequired, deleteTheme);

export default router;
