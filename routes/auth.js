const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');
const { authenticate, auditLog } = require('../middleware/auth');

// POST /api/auth/login
// Accepts: { emp_id: 'EMP001' or email: 'vipin@mrei.ac.in', password: '...' }
router.post('/login', async (req, res) => {
  const { emp_id, email, password } = req.body;
  const identifier = emp_id || email;

  if (!identifier || !password)
    return res.status(400).json({ error: 'Employee ID (or email) and password required' });

  try {
    // Allow login by emp_id OR email
    const result = await pool.query(
      'SELECT * FROM trainers WHERE (emp_id = $1 OR email = $1) AND is_active = true',
      [identifier.trim().toUpperCase() === identifier.trim() ? identifier.trim() : identifier.trim()]
    );

    if (!result.rows.length)
      return res.status(401).json({ error: 'Invalid credentials' });

    const trainer = result.rows[0];
    const valid = await bcrypt.compare(password, trainer.password_hash);
    if (!valid)
      return res.status(401).json({ error: 'Invalid credentials' });

   await pool.query('UPDATE trainers SET last_login = NOW() WHERE id = $1', [trainer.id]).catch(() => {});

    const token = jwt.sign(
      { id: trainer.id, emp_id: trainer.emp_id, role: trainer.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
    );

    await auditLog(trainer.id, 'LOGIN', 'trainer', trainer.id, {}, req.ip);

    res.json({
      token,
      trainer: {
        id: trainer.id,
        emp_id: trainer.emp_id,
        name: trainer.name,
        email: trainer.email,
        role: trainer.role,
        university: trainer.university,
        department: trainer.department
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/auth/change-password
router.post('/change-password', authenticate, async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password)
    return res.status(400).json({ error: 'Both passwords required' });
  if (new_password.length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters' });

  try {
    const result = await pool.query('SELECT password_hash FROM trainers WHERE id = $1', [req.trainer.id]);
    const valid = await bcrypt.compare(current_password, result.rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Current password incorrect' });

    const hash = await bcrypt.hash(new_password, 12);
    await pool.query('UPDATE trainers SET password_hash = $1 WHERE id = $2', [hash, req.trainer.id]);

    await auditLog(req.trainer.id, 'CHANGE_PASSWORD', 'trainer', req.trainer.id, {}, req.ip);
    res.json({ message: 'Password changed successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/auth/me
router.get('/me', authenticate, (req, res) => {
  res.json({ trainer: req.trainer });
});

module.exports = router;
