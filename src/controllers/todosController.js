import pool from '../db/pool.js';

function formatTodo(row) {
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
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
    res.json({ success: true, todos: result.rows.map(formatTodo) });
  } catch (e) {
    console.error('[todos] listTodos:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
}

// POST /api/todos
// Body: { title, notes?, dueDates: string[] (>=1), reminderAts?: (string|null)[] }
// reminderAts, if present, must be the same length as dueDates (parallel arrays) —
// the client computes each date's own reminder instant so the server never has
// to do timezone-sensitive date math.
export async function createTodo(req, res) {
  const userId = req.userId;
  const { title, notes, dueDates, reminderAts } = req.body;

  if (!title || !Array.isArray(dueDates) || dueDates.length === 0) {
    return res.status(400).json({ success: false, message: 'Title and dueDates are required' });
  }
  if (reminderAts !== undefined && (!Array.isArray(reminderAts) || reminderAts.length !== dueDates.length)) {
    return res.status(400).json({ success: false, message: 'reminderAts must match dueDates length' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const firstResult = await client.query(
      `INSERT INTO todos (user_id, title, notes, due_date, reminder_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [userId, title, notes || null, dueDates[0], reminderAts?.[0] || null],
    );
    let rows = [firstResult.rows[0]];

    if (dueDates.length > 1) {
      const leaderId = firstResult.rows[0].id;
      await client.query('UPDATE todos SET group_id = $1 WHERE id = $1', [leaderId]);
      rows[0].group_id = leaderId;

      for (let i = 1; i < dueDates.length; i++) {
        const result = await client.query(
          `INSERT INTO todos (user_id, title, notes, due_date, reminder_at, group_id)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING *`,
          [userId, title, notes || null, dueDates[i], reminderAts?.[i] || null, leaderId],
        );
        rows.push(result.rows[0]);
      }
    }

    await client.query('COMMIT');
    res.json({ success: true, todos: rows.map(formatTodo) });
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
  const { title, notes, dueDate, reminderAt } = req.body;

  const fields = [];
  const values = [];
  let i = 1;

  if (title !== undefined) { fields.push(`title = $${i++}`); values.push(title); }
  if (notes !== undefined) { fields.push(`notes = $${i++}`); values.push(notes); }
  if (dueDate !== undefined) { fields.push(`due_date = $${i++}`); values.push(dueDate); }
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
    res.json({ success: true, todo: formatTodo(result.rows[0]) });
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
    res.json({ success: true, todo: formatTodo(result.rows[0]) });
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
