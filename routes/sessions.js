const express = require('express');
const router  = express.Router();
const pool    = require('../db/pool');
const { authenticate, requireSuperAdmin, auditLog } = require('../middleware/auth');

// GET /api/sessions/active  — public, used by student entry page
router.get('/active', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, name, type FROM academic_sessions WHERE is_active = true LIMIT 1`
    );
    res.json({ session: r.rows[0] || null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/sessions  — all sessions, super admin only
router.get('/', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT s.id, s.name, s.type, s.is_active, s.created_at, t.name as created_by_name
       FROM academic_sessions s
       LEFT JOIN trainers t ON s.created_by = t.id
       ORDER BY s.created_at DESC`
    );
    res.json({ sessions: r.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/sessions  — create new session
router.post('/', authenticate, requireSuperAdmin, async (req, res) => {
  const { name, type } = req.body;
  if (!name || !type) return res.status(400).json({ error: 'name and type required' });
  if (!['Even', 'Odd'].includes(type)) return res.status(400).json({ error: 'type must be Even or Odd' });
  try {
    const r = await pool.query(
      `INSERT INTO academic_sessions (name, type, is_active, created_by)
       VALUES ($1, $2, false, $3)
       RETURNING id, name, type, is_active, created_at`,
      [name.trim(), type, req.trainer.id]
    );
    await auditLog(req.trainer.id, 'CREATE_SESSION', 'academic_session', r.rows[0].id, { name, type }, req.ip);
    res.status(201).json({ session: r.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Session with this name already exists' });
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/sessions/:id/activate  — set as active (deactivates all others)
// NOTE: /activate must be registered before /:id to avoid conflict
router.patch('/:id/activate', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    await pool.query('UPDATE academic_sessions SET is_active = false');
    const r = await pool.query(
      `UPDATE academic_sessions SET is_active = true WHERE id = $1
       RETURNING id, name, type, is_active`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Session not found' });
    await auditLog(req.trainer.id, 'ACTIVATE_SESSION', 'academic_session', req.params.id, {}, req.ip);
    res.json({ session: r.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/sessions/:id  — rename / update type
router.patch('/:id', authenticate, requireSuperAdmin, async (req, res) => {
  const { name, type } = req.body;
  try {
    const r = await pool.query(
      `UPDATE academic_sessions
       SET name = COALESCE($1, name), type = COALESCE($2, type)
       WHERE id = $3
       RETURNING id, name, type, is_active`,
      [name?.trim(), type, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Session not found' });
    res.json({ session: r.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
