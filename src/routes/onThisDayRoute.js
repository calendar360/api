import express from 'express';
import { authRequired, authOptional } from '../middleware/auth.js';
import {
  listPosts,
  getPost,
  createPost,
  updatePost,
  deletePost,
} from '../controllers/onThisDayController.js';

const router = express.Router();

router.get('/', authOptional, listPosts);
router.get('/:id', authOptional, getPost);
router.post('/', authRequired, createPost);
router.put('/:id', authRequired, updatePost);
router.delete('/:id', authRequired, deletePost);

export default router;
