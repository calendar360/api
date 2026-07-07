import express from 'express';
import { authRequired } from '../middleware/auth.js';
import {
  getMyMeetings,
  getPendingInvitations,
  createMeeting,
  inviteToMeeting,
  respondToMeeting,
  deleteMeeting,
  searchUsers,
} from '../controllers/meetingsController.js';

const router = express.Router();

router.get('/mine', authRequired, getMyMeetings);
router.get('/invitations', authRequired, getPendingInvitations);
router.get('/search-users', authRequired, searchUsers);
router.post('/', authRequired, createMeeting);
router.post('/:id/invite', authRequired, inviteToMeeting);
router.patch('/:id/respond', authRequired, respondToMeeting);
router.delete('/:id', authRequired, deleteMeeting);

export default router;
