import express from 'express';
import { authRequired } from '../middleware/auth.js';
import {
  listTodos,
  createTodo,
  updateTodo,
  toggleTodo,
  deleteTodo,
  createSubtask,
  toggleSubtask,
  deleteSubtask,
} from '../controllers/todosController.js';

const router = express.Router();

router.get('/', authRequired, listTodos);
router.post('/', authRequired, createTodo);
router.put('/:id', authRequired, updateTodo);
router.patch('/:id/toggle', authRequired, toggleTodo);
router.delete('/:id', authRequired, deleteTodo);
router.post('/:id/subtasks', authRequired, createSubtask);
router.patch('/:id/subtasks/:subtaskId/toggle', authRequired, toggleSubtask);
router.delete('/:id/subtasks/:subtaskId', authRequired, deleteSubtask);

export default router;
