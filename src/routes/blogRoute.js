import express from 'express';
import { authOptional, authRequired } from '../middleware/auth.js';
import { adminRequired, adminFlag } from '../middleware/requireAdmin.js';
import {
  listPosts,
  getPost,
  createPost,
  updatePost,
  deletePost,
  likePost,
  unlikePost,
  listComments,
  createComment,
  updateComment,
  deleteComment,
} from '../controllers/blogController.js';

const router = express.Router();

// Reading is public. Signing in only adds `likedByMe`, and being an admin only
// adds drafts to the feed — hence authOptional + adminFlag rather than a guard.
router.get('/', authOptional, adminFlag, listPosts);
router.get('/:id', authOptional, adminFlag, getPost);
router.get('/:id/comments', authOptional, listComments);

// Authoring is admin-only.
router.post('/', authRequired, adminRequired, createPost);
router.put('/:id', authRequired, adminRequired, updatePost);
router.delete('/:id', authRequired, adminRequired, deletePost);

// Interaction is open to any signed-in user.
router.post('/:id/like', authRequired, likePost);
router.delete('/:id/like', authRequired, unlikePost);
router.post('/:id/comments', authRequired, createComment);
router.put('/:id/comments/:commentId', authRequired, updateComment);
// adminFlag so an admin can moderate a comment that is not their own.
router.delete('/:id/comments/:commentId', authRequired, adminFlag, deleteComment);

export default router;
