const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');
const { authenticate, requireSuperAdmin, auditLog } = require('../middleware/auth');

// GET /api/trainers — list all (super admin only)
router.get('/', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, emp_id, name, email, role, university, department, is_active, created_at, last_login
       FROM trainers ORDER BY role DESC, name ASC`
    );
    res.json({ trainers: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/trainers — create trainer (super admin only)
router.post('/', authenticate, requireSuperAdmin, async (req, res) => {
  const { emp_id, name, email, role, university, department } = req.body;
  if (!emp_id || !name || !email)
    return res.status(400).json({ error: 'emp_id, name, email required' });

  // Only Vipin & Ankur can create super_admin
  if (role === 'super_admin') {
    const isGranter = ['EMP001', 'EMP002'].includes(req.trainer.emp_id);
    if (!isGranter) return res.status(403).json({ error: 'Only Vipin or Ankur can grant super admin role' });
  }

  try {
    // Default password = emp_id
    const hash = await bcrypt.hash(emp_id.toUpperCase(), 12);
    const result = await pool.query(
      `INSERT INTO trainers (emp_id, name, email, password_hash, role, university, department)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, emp_id, name, email, role`,
      [emp_id.toUpperCase(), name, email, hash, role || 'trainer', university || 'BOTH', department]
    );
    await auditLog(req.trainer.id, 'CREATE_TRAINER', 'trainer', result.rows[0].id, { emp_id, name, role }, req.ip);
    res.status(201).json({ trainer: result.rows[0], message: 'Trainer created. Default password = emp_id' });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'emp_id or email already exists' });
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/trainers/:id — update trainer
router.patch('/:id', authenticate, requireSuperAdmin, async (req, res) => {
  const { name, email, role, university, department, is_active } = req.body;
  const { id } = req.params;

  if (role === 'super_admin') {
    const isGranter = ['EMP001', 'EMP002'].includes(req.trainer.emp_id);
    if (!isGranter) return res.status(403).json({ error: 'Only Vipin or Ankur can grant super admin role' });
  }

  try {
    const result = await pool.query(
      `UPDATE trainers SET name=COALESCE($1,name), email=COALESCE($2,email),
       role=COALESCE($3,role), university=COALESCE($4,university),
       department=COALESCE($5,department), is_active=COALESCE($6,is_active),
       updated_at=NOW() WHERE id=$7 RETURNING id, emp_id, name, email, role, is_active`,
      [name, email, role, university, department, is_active, id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Trainer not found' });
    await auditLog(req.trainer.id, 'UPDATE_TRAINER', 'trainer', id, req.body, req.ip);
    res.json({ trainer: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/trainers/:id — deactivate (soft delete)
router.delete('/:id', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    await pool.query('UPDATE trainers SET is_active=false WHERE id=$1', [req.params.id]);
    await auditLog(req.trainer.id, 'DEACTIVATE_TRAINER', 'trainer', req.params.id, {}, req.ip);
    res.json({ message: 'Trainer deactivated' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/trainers/:id/reset-password — reset to emp_id
router.post('/:id/reset-password', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const trainer = await pool.query('SELECT emp_id FROM trainers WHERE id=$1', [req.params.id]);
    if (!trainer.rows.length) return res.status(404).json({ error: 'Trainer not found' });
    const hash = await bcrypt.hash(trainer.rows[0].emp_id, 12);
    await pool.query('UPDATE trainers SET password_hash=$1 WHERE id=$2', [hash, req.params.id]);
    await auditLog(req.trainer.id, 'RESET_PASSWORD', 'trainer', req.params.id, {}, req.ip);
    res.json({ message: 'Password reset to emp_id' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
