import express from 'express';
import { authRequired, authOptional } from '../middleware/auth.js';
import { adminFlag } from '../middleware/requireAdmin.js';
import { rateLimit } from '../middleware/rateLimit.js';
import {
  listPosts,
  getPost,
  createPost,
  updatePost,
  deletePost,
  recordView,
  listTrackedViewers,
  addTrackedViewer,
  removeTrackedViewer,
} from '../controllers/onThisDayController.js';

const router = express.Router();

// adminFlag rather than adminRequired: reading stays public, and the flag only
// decides whether the view counts are included in the response.
router.get('/', authOptional, adminFlag, listPosts);

// Literal path before the parameterised one, or ":id" swallows it.
router.post(
  '/:id/view',
  authOptional,
  rateLimit({ max: 120, windowMs: 60 * 60 * 1000, name: 'otd-view' }),
  recordView,
);

// Tracked viewers. Registered before "/:id" or Express matches the literal
// segment as an id, and "tracked" is not a number.
router.get('/tracked', authRequired, listTrackedViewers);
router.post('/tracked', authRequired, addTrackedViewer);
router.delete('/tracked/:id', authRequired, removeTrackedViewer);

router.get('/:id', authOptional, adminFlag, getPost);
router.post('/', authRequired, createPost);
router.put('/:id', authRequired, updatePost);
router.delete('/:id', authRequired, deletePost);

export default router;
