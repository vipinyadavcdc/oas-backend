const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');
const { authenticate, requireSuperAdmin, requireMasterAdmin, auditLog } = require('../middleware/auth');

// GET /api/trainers — list all (super_admin and above)
router.get('/', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, emp_id, name, email, role, designation, mobile, university, department, is_active, created_at, last_login
       FROM trainers ORDER BY
         CASE role WHEN 'master_admin' THEN 1 WHEN 'super_admin' THEN 2 ELSE 3 END, name ASC`
    );
    res.json({ trainers: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/trainers — create new team member (master_admin only)
router.post('/', authenticate, requireMasterAdmin, async (req, res) => {
  const { emp_id, name, email, role, designation, mobile, university, department } = req.body;
  if (!emp_id || !name || !email)
    return res.status(400).json({ error: 'emp_id, name, email required' });

  try {
    const hash = await bcrypt.hash(emp_id, 12);
    const result = await pool.query(
      `INSERT INTO trainers (emp_id, name, email, password_hash, role, designation, mobile, university, department)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, emp_id, name, email, role, designation`,
      [emp_id, name, email, hash, role || 'trainer', designation, mobile, university || 'BOTH', department]
    );
    await auditLog(req.trainer.id, 'CREATE_TRAINER', 'trainer', result.rows[0].id, { emp_id, name, role }, req.ip);
    res.status(201).json({ trainer: result.rows[0], message: 'User created. Default password = employee code' });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Employee code or email already exists' });
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/trainers/:id — update (master_admin only)
router.patch('/:id', authenticate, requireMasterAdmin, async (req, res) => {
  const { name, email, role, designation, mobile, university, department, is_active } = req.body;

  try {
    const result = await pool.query(
      `UPDATE trainers SET
         name=COALESCE($1,name), email=COALESCE($2,email),
         role=COALESCE($3,role), designation=COALESCE($4,designation),
         mobile=COALESCE($5,mobile), university=COALESCE($6,university),
         department=COALESCE($7,department), is_active=COALESCE($8,is_active)
       WHERE id=$9
       RETURNING id, emp_id, name, email, role, designation, is_active`,
      [name, email, role, designation, mobile, university, department, is_active, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'User not found' });
    await auditLog(req.trainer.id, 'UPDATE_TRAINER', 'trainer', req.params.id, req.body, req.ip);
    res.json({ trainer: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/trainers/:id — deactivate (master_admin only)
router.delete('/:id', authenticate, requireMasterAdmin, async (req, res) => {
  try {
    // Prevent deactivating own account
    if (req.params.id === req.trainer.id)
      return res.status(400).json({ error: 'Cannot deactivate your own account' });
    await pool.query('UPDATE trainers SET is_active=false WHERE id=$1', [req.params.id]);
    await auditLog(req.trainer.id, 'DEACTIVATE_TRAINER', 'trainer', req.params.id, {}, req.ip);
    res.json({ message: 'User deactivated' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/trainers/:id/reset-password — reset to emp_id (master_admin only)
router.post('/:id/reset-password', authenticate, requireMasterAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT emp_id, name FROM trainers WHERE id=$1', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'User not found' });
    const { emp_id, name } = result.rows[0];
    const hash = await bcrypt.hash(emp_id, 12);
    await pool.query('UPDATE trainers SET password_hash=$1 WHERE id=$2', [hash, req.params.id]);
    await auditLog(req.trainer.id, 'RESET_PASSWORD', 'trainer', req.params.id, { name }, req.ip);
    res.json({ message: 'Password reset to employee code for ' + name });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
