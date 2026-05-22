import pool from '../db/pool.js';

export const listWords = async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, word, month, year, updated_at FROM words_for_month ORDER BY year DESC, month ASC`,
    );
    res.json({
      success: true,
      words: result.rows.map((r) => ({
        id: r.id,
        word: r.word,
        month: r.month,
        year: r.year,
        updatedAt: r.updated_at,
      })),
    });
  } catch (error) {
    console.error('listWords', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

export const upsertWord = async (req, res) => {
  try {
    const { id } = req.params;
    const { word, month, year } = req.body;
    if (!word?.trim()) {
      return res.status(400).json({ success: false, message: 'word required' });
    }

    const admin = await pool.query('SELECT is_admin FROM users WHERE id = $1', [req.userId]);
    if (!admin.rows[0]?.is_admin) {
      return res.status(403).json({ success: false, message: 'Admin only' });
    }

    await pool.query(
      `INSERT INTO words_for_month (id, word, month, year, created_by_user_id, updated_at)
       VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
       ON CONFLICT (id) DO UPDATE SET
         word = EXCLUDED.word,
         month = EXCLUDED.month,
         year = EXCLUDED.year,
         created_by_user_id = EXCLUDED.created_by_user_id,
         updated_at = CURRENT_TIMESTAMP`,
      [id, word.trim(), month, year, req.userId],
    );

    const row = (await pool.query('SELECT * FROM words_for_month WHERE id = $1', [id])).rows[0];
    res.json({
      success: true,
      entry: {
        id: row.id,
        word: row.word,
        month: row.month,
        year: row.year,
        updatedAt: row.updated_at,
      },
    });
  } catch (error) {
    console.error('upsertWord', error);
    res.status(500).json({ success: false, message: error.message });
  }
};
