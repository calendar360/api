import pool from '../db/pool.js';
import { uploadPublicUrl } from '../utils/publicUrl.js';

function mapTheme(row, req) {
  return {
    id: row.id,
    year: row.year,
    title: row.title,
    description: row.description,
    imagePath: row.image_path,
    imageUrl: row.image_path ? uploadPublicUrl(req, row.image_path) : null,
    createdAt: row.created_at,
  };
}

export const listThemes = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM theme_of_year ORDER BY year DESC`,
    );
    res.json({ success: true, themes: result.rows.map((r) => mapTheme(r, req)) });
  } catch (error) {
    console.error('listThemes', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

export const getTheme = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(`SELECT * FROM theme_of_year WHERE id = $1`, [id]);
    if (!result.rows.length) {
      return res.status(404).json({ success: false, message: 'Theme not found' });
    }
    res.json({ success: true, theme: mapTheme(result.rows[0], req) });
  } catch (error) {
    console.error('getTheme', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

async function requireAdmin(req, res) {
  const user = await pool.query('SELECT is_admin FROM users WHERE id = $1', [req.userId]);
  if (!user.rows[0]?.is_admin) {
    res.status(403).json({ success: false, message: 'Admin only' });
    return false;
  }
  return true;
}

export const createTheme = async (req, res) => {
  try {
    if (!await requireAdmin(req, res)) return;
    const { year, title, description, imagePath } = req.body;
    if (!year || !title) {
      return res.status(400).json({ success: false, message: 'year and title required' });
    }
    const result = await pool.query(
      `INSERT INTO theme_of_year (year, title, description, image_path, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [year, title, description ?? null, imagePath ?? null, req.userId],
    );
    res.status(201).json({ success: true, theme: mapTheme(result.rows[0], req) });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ success: false, message: `Theme for year ${req.body.year} already exists` });
    }
    console.error('createTheme', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

export const updateTheme = async (req, res) => {
  try {
    if (!await requireAdmin(req, res)) return;
    const { id } = req.params;
    const { year, title, description, imagePath } = req.body;
    const existing = await pool.query(`SELECT id FROM theme_of_year WHERE id = $1`, [id]);
    if (!existing.rows.length) {
      return res.status(404).json({ success: false, message: 'Theme not found' });
    }
    const result = await pool.query(
      `UPDATE theme_of_year SET
        year = COALESCE($1, year),
        title = COALESCE($2, title),
        description = COALESCE($3, description),
        image_path = COALESCE($4, image_path),
        updated_at = CURRENT_TIMESTAMP
       WHERE id = $5 RETURNING *`,
      [year ?? null, title ?? null, description ?? null, imagePath ?? null, id],
    );
    res.json({ success: true, theme: mapTheme(result.rows[0], req) });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ success: false, message: `Theme for that year already exists` });
    }
    console.error('updateTheme', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

export const deleteTheme = async (req, res) => {
  try {
    if (!await requireAdmin(req, res)) return;
    const { id } = req.params;
    const result = await pool.query(`DELETE FROM theme_of_year WHERE id = $1`, [id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: 'Theme not found' });
    }
    res.json({ success: true });
  } catch (error) {
    console.error('deleteTheme', error);
    res.status(500).json({ success: false, message: error.message });
  }
};
