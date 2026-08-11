import express from 'express';
import {
  listEvents,
  createEvent,
  updateEvent,
  deleteEvent,
  listWishes,
  createWish,
  updateWish,
  deleteWish,
} from '../controllers/eventsController.js';
import { authOptional, authRequired } from '../middleware/auth.js';

const router = express.Router();

router.get('/', authOptional, listEvents);
router.post('/', authRequired, createEvent);
router.put('/:id', authRequired, updateEvent);
router.delete('/:id', authRequired, deleteEvent);
router.get('/:id/wishes', listWishes);
router.post('/:id/wishes', authRequired, createWish);
router.put('/:id/wishes/:wishId', authRequired, updateWish);
router.delete('/:id/wishes/:wishId', authRequired, deleteWish);

export default router;
