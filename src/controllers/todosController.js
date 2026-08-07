import pool from '../db/pool.js';

function formatTodo(row, subtasks = []) {
  return {
    id: row.id,
    title: row.title,
    notes: row.notes || null,
    dueDate: row.due_date instanceof Date
      ? row.due_date.toISOString().slice(0, 10)
      : row.due_date,
    reminderAt: row.reminder_at || null,
    isDone: row.is_done === true,
    groupId: row.group_id || null,
    color: row.color || null,
    subtasks: subtasks.map(formatSubtask),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function formatSubtask(row) {
  return {
    id: row.id,
    title: row.title,
    isDone: row.is_done === true,
  };
}

async function fetchSubtasksForTodos(todoIds) {
  if (!todoIds.length) return {};
  const result = await pool.query(
    `SELECT * FROM todo_subtasks WHERE todo_id = ANY($1) ORDER BY position ASC, id ASC`,
    [todoIds],
  );
  const map = {};
  for (const row of result.rows) {
    if (!map[row.todo_id]) map[row.todo_id] = [];
    map[row.todo_id].push(row);
  }
  return map;
}

// GET /api/todos
export async function listTodos(req, res) {
  const userId = req.userId;
  const { date } = req.query;
  try {
    const result = date
      ? await pool.query(
          `SELECT * FROM todos WHERE user_id = $1 AND due_date = $2
           ORDER BY reminder_at ASC NULLS LAST, created_at ASC`,
          [userId, date],
        )
      : await pool.query(
          `SELECT * FROM todos WHERE user_id = $1
           ORDER BY due_date ASC, reminder_at ASC NULLS LAST, created_at ASC`,
          [userId],
        );
    const subtasksMap = await fetchSubtasksForTodos(result.rows.map((r) => r.id));
    const todos = result.rows.map((row) => formatTodo(row, subtasksMap[row.id] || []));
    res.json({ success: true, todos });
  } catch (e) {
    console.error('[todos] listTodos:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
}

// POST /api/todos
// Body: { title, notes?, dueDates: string[] (>=1), reminderAts?: (string|null)[],
//         color?, subtasks?: string[] (titles, applied to every created day) }
// reminderAts, if present, must be the same length as dueDates (parallel arrays) —
// the client computes each date's own reminder instant so the server never has
// to do timezone-sensitive date math.
export async function createTodo(req, res) {
  const userId = req.userId;
  const { title, notes, dueDates, reminderAts, color, subtasks } = req.body;

  if (!title || !Array.isArray(dueDates) || dueDates.length === 0) {
    return res.status(400).json({ success: false, message: 'Title and dueDates are required' });
  }
  if (reminderAts !== undefined && (!Array.isArray(reminderAts) || reminderAts.length !== dueDates.length)) {
    return res.status(400).json({ success: false, message: 'reminderAts must match dueDates length' });
  }
  const subtaskTitles = Array.isArray(subtasks) ? subtasks.filter((t) => typeof t === 'string' && t.trim()) : [];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const firstResult = await client.query(
      `INSERT INTO todos (user_id, title, notes, due_date, reminder_at, color)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [userId, title, notes || null, dueDates[0], reminderAts?.[0] || null, color || null],
    );
    let rows = [firstResult.rows[0]];

    if (dueDates.length > 1) {
      const leaderId = firstResult.rows[0].id;
      await client.query('UPDATE todos SET group_id = $1 WHERE id = $1', [leaderId]);
      rows[0].group_id = leaderId;

      for (let i = 1; i < dueDates.length; i++) {
        const result = await client.query(
          `INSERT INTO todos (user_id, title, notes, due_date, reminder_at, group_id, color)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING *`,
          [userId, title, notes || null, dueDates[i], reminderAts?.[i] || null, leaderId, color || null],
        );
        rows.push(result.rows[0]);
      }
    }

    const subtasksMap = {};
    if (subtaskTitles.length > 0) {
      for (const row of rows) {
        subtasksMap[row.id] = [];
        for (let pos = 0; pos < subtaskTitles.length; pos++) {
          const stResult = await client.query(
            `INSERT INTO todo_subtasks (todo_id, title, position) VALUES ($1, $2, $3) RETURNING *`,
            [row.id, subtaskTitles[pos], pos],
          );
          subtasksMap[row.id].push(stResult.rows[0]);
        }
      }
    }

    await client.query('COMMIT');
    res.json({ success: true, todos: rows.map((row) => formatTodo(row, subtasksMap[row.id] || [])) });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[todos] createTodo:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  } finally {
    client.release();
  }
}

// PUT /api/todos/:id
export async function updateTodo(req, res) {
  const userId = req.userId;
  const todoId = parseInt(req.params.id, 10);
  const { title, notes, dueDate, reminderAt, color } = req.body;

  const fields = [];
  const values = [];
  let i = 1;

  if (title !== undefined) { fields.push(`title = $${i++}`); values.push(title); }
  if (notes !== undefined) { fields.push(`notes = $${i++}`); values.push(notes); }
  if (dueDate !== undefined) { fields.push(`due_date = $${i++}`); values.push(dueDate); }
  if (Object.prototype.hasOwnProperty.call(req.body, 'color')) {
    fields.push(`color = $${i++}`);
    values.push(color || null);
  }
  // reminderAt is explicitly nullable — a key present with value null clears it,
  // a key absent from the body leaves the existing reminder untouched.
  if (Object.prototype.hasOwnProperty.call(req.body, 'reminderAt')) {
    fields.push(`reminder_at = $${i++}`);
    values.push(reminderAt || null);
  }

  if (fields.length === 0) {
    return res.status(400).json({ success: false, message: 'No fields to update' });
  }
  fields.push(`updated_at = CURRENT_TIMESTAMP`);

  values.push(todoId, userId);
  try {
    const result = await pool.query(
      `UPDATE todos SET ${fields.join(', ')} WHERE id = $${i++} AND user_id = $${i} RETURNING *`,
      values,
    );
    if (!result.rows.length) {
      return res.status(404).json({ success: false, message: 'Todo not found' });
    }
    const subtasksMap = await fetchSubtasksForTodos([todoId]);
    res.json({ success: true, todo: formatTodo(result.rows[0], subtasksMap[todoId] || []) });
  } catch (e) {
    console.error('[todos] updateTodo:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
}

// PATCH /api/todos/:id/toggle
export async function toggleTodo(req, res) {
  const userId = req.userId;
  const todoId = parseInt(req.params.id, 10);
  const { isDone } = req.body;

  if (typeof isDone !== 'boolean') {
    return res.status(400).json({ success: false, message: 'isDone (boolean) is required' });
  }

  try {
    const result = await pool.query(
      `UPDATE todos SET is_done = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 AND user_id = $3 RETURNING *`,
      [isDone, todoId, userId],
    );
    if (!result.rows.length) {
      return res.status(404).json({ success: false, message: 'Todo not found' });
    }
    const subtasksMap = await fetchSubtasksForTodos([todoId]);
    res.json({ success: true, todo: formatTodo(result.rows[0], subtasksMap[todoId] || []) });
  } catch (e) {
    console.error('[todos] toggleTodo:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
}

// DELETE /api/todos/:id
export async function deleteTodo(req, res) {
  const userId = req.userId;
  const todoId = parseInt(req.params.id, 10);
  try {
    const result = await pool.query(
      'DELETE FROM todos WHERE id = $1 AND user_id = $2 RETURNING id',
      [todoId, userId],
    );
    if (!result.rows.length) {
      return res.status(404).json({ success: false, message: 'Todo not found' });
    }
    res.json({ success: true });
  } catch (e) {
    console.error('[todos] deleteTodo:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
}

// Verifies the todo belongs to userId; returns the todo row or null.
async function ownedTodo(todoId, userId) {
  const result = await pool.query('SELECT id FROM todos WHERE id = $1 AND user_id = $2', [todoId, userId]);
  return result.rows[0] || null;
}

// POST /api/todos/:id/subtasks
export async function createSubtask(req, res) {
  const userId = req.userId;
  const todoId = parseInt(req.params.id, 10);
  const { title } = req.body;

  if (!title || !title.trim()) {
    return res.status(400).json({ success: false, message: 'title is required' });
  }
  try {
    if (!(await ownedTodo(todoId, userId))) {
      return res.status(404).json({ success: false, message: 'Todo not found' });
    }
    const posResult = await pool.query(
      'SELECT COALESCE(MAX(position), -1) + 1 AS next_pos FROM todo_subtasks WHERE todo_id = $1',
      [todoId],
    );
    const result = await pool.query(
      `INSERT INTO todo_subtasks (todo_id, title, position) VALUES ($1, $2, $3) RETURNING *`,
      [todoId, title.trim(), posResult.rows[0].next_pos],
    );
    res.json({ success: true, subtask: formatSubtask(result.rows[0]) });
  } catch (e) {
    console.error('[todos] createSubtask:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
}

// PATCH /api/todos/:id/subtasks/:subtaskId/toggle
export async function toggleSubtask(req, res) {
  const userId = req.userId;
  const todoId = parseInt(req.params.id, 10);
  const subtaskId = parseInt(req.params.subtaskId, 10);
  const { isDone } = req.body;

  if (typeof isDone !== 'boolean') {
    return res.status(400).json({ success: false, message: 'isDone (boolean) is required' });
  }
  try {
    if (!(await ownedTodo(todoId, userId))) {
      return res.status(404).json({ success: false, message: 'Todo not found' });
    }
    const result = await pool.query(
      `UPDATE todo_subtasks SET is_done = $1 WHERE id = $2 AND todo_id = $3 RETURNING *`,
      [isDone, subtaskId, todoId],
    );
    if (!result.rows.length) {
      return res.status(404).json({ success: false, message: 'Subtask not found' });
    }
    res.json({ success: true, subtask: formatSubtask(result.rows[0]) });
  } catch (e) {
    console.error('[todos] toggleSubtask:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
}

// DELETE /api/todos/:id/subtasks/:subtaskId
export async function deleteSubtask(req, res) {
  const userId = req.userId;
  const todoId = parseInt(req.params.id, 10);
  const subtaskId = parseInt(req.params.subtaskId, 10);
  try {
    if (!(await ownedTodo(todoId, userId))) {
      return res.status(404).json({ success: false, message: 'Todo not found' });
    }
    const result = await pool.query(
      'DELETE FROM todo_subtasks WHERE id = $1 AND todo_id = $2 RETURNING id',
      [subtaskId, todoId],
    );
    if (!result.rows.length) {
      return res.status(404).json({ success: false, message: 'Subtask not found' });
    }
    res.json({ success: true });
  } catch (e) {
    console.error('[todos] deleteSubtask:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
}
