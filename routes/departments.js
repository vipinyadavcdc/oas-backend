const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { authenticate, requireSuperAdmin, auditLog } = require('../middleware/auth');

// ── PUBLIC ───────────────────────────────────────────────────────────────────

// GET /api/departments?university=MRIIRS  — public, for student entry + exam creation
router.get('/', async (req, res) => {
  try {
    const { university } = req.query;
    const result = await pool.query(
      `SELECT id, name, university
       FROM departments
       WHERE is_active = true
       ${university ? 'AND (university = $1 OR university = \'BOTH\')' : ''}
       ORDER BY university, name ASC`,
      university ? [university] : []
    );
    res.json({ departments: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/departments/:id/sections  — public, for student entry page
router.get('/:id/sections', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name FROM sections
       WHERE department_id = $1 AND is_active = true
       ORDER BY name ASC`,
      [req.params.id]
    );
    res.json({ sections: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/departments/tree  — public, full tree for display
router.get('/tree', async (req, res) => {
  try {
    const depts = await pool.query(
      `SELECT id, name, university FROM departments WHERE is_active = true ORDER BY university, name`
    );
    const sects = await pool.query(
      `SELECT id, department_id, name FROM sections WHERE is_active = true ORDER BY name`
    );

    const tree = depts.rows.map(d => ({
      ...d,
      sections: sects.rows.filter(s => s.department_id === d.id)
    }));

    const grouped = {
      MRIIRS: tree.filter(d => d.university === 'MRIIRS'),
      MRU:    tree.filter(d => d.university === 'MRU'),
    };

    res.json({ tree: grouped });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ── SUPER ADMIN ONLY ─────────────────────────────────────────────────────────

// GET /api/departments/all  — all including inactive, for admin management
router.get('/all', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const depts = await pool.query(
      `SELECT id, name, university, is_active, created_at FROM departments ORDER BY university, name`
    );
    const sects = await pool.query(
      `SELECT id, department_id, name, is_active FROM sections ORDER BY name`
    );
    const result = depts.rows.map(d => ({
      ...d,
      sections: sects.rows.filter(s => s.department_id === d.id)
    }));
    res.json({ departments: result });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/departments  — create department
router.post('/', authenticate, requireSuperAdmin, async (req, res) => {
  const { name, university } = req.body;
  if (!name || !university) return res.status(400).json({ error: 'name and university required' });
  if (!['MRIIRS', 'MRU'].includes(university)) return res.status(400).json({ error: 'university must be MRIIRS or MRU' });

  try {
    const result = await pool.query(
      `INSERT INTO departments (name, university) VALUES ($1, $2)
       RETURNING id, name, university, is_active`,
      [name.trim(), university]
    );
    await auditLog(req.trainer.id, 'CREATE_DEPARTMENT', 'department', result.rows[0].id, { name, university }, req.ip);
    res.status(201).json({ department: { ...result.rows[0], sections: [] } });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Department already exists for this university' });
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/departments/:id  — rename or toggle active
router.patch('/:id', authenticate, requireSuperAdmin, async (req, res) => {
  const { name, is_active } = req.body;
  try {
    const result = await pool.query(
      `UPDATE departments SET
         name      = COALESCE($1, name),
         is_active = COALESCE($2, is_active)
       WHERE id = $3
       RETURNING id, name, university, is_active`,
      [name?.trim(), is_active, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Department not found' });
    await auditLog(req.trainer.id, 'UPDATE_DEPARTMENT', 'department', req.params.id, req.body, req.ip);
    res.json({ department: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/departments/:id  — hard delete only if no sections or student sessions
router.delete('/:id', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    // Soft delete — deactivate instead of hard delete to protect historical data
    await pool.query('UPDATE departments SET is_active = false WHERE id = $1', [req.params.id]);
    await pool.query('UPDATE sections SET is_active = false WHERE department_id = $1', [req.params.id]);
    await auditLog(req.trainer.id, 'DEACTIVATE_DEPARTMENT', 'department', req.params.id, {}, req.ip);
    res.json({ message: 'Department deactivated' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/departments/:id/sections  — add section to a dept
router.post('/:id/sections', authenticate, requireSuperAdmin, async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'section name required' });

  try {
    // Check dept exists
    const dept = await pool.query('SELECT id FROM departments WHERE id = $1', [req.params.id]);
    if (!dept.rows.length) return res.status(404).json({ error: 'Department not found' });

    const result = await pool.query(
      `INSERT INTO sections (department_id, name) VALUES ($1, $2)
       RETURNING id, department_id, name, is_active`,
      [req.params.id, name.trim().toUpperCase()]
    );
    await auditLog(req.trainer.id, 'CREATE_SECTION', 'section', result.rows[0].id, { name, department_id: req.params.id }, req.ip);
    res.status(201).json({ section: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Section already exists in this department' });
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/departments/sections/:sectionId  — rename or toggle section
router.patch('/sections/:sectionId', authenticate, requireSuperAdmin, async (req, res) => {
  const { name, is_active } = req.body;
  try {
    const result = await pool.query(
      `UPDATE sections SET
         name      = COALESCE($1, name),
         is_active = COALESCE($2, is_active)
       WHERE id = $3
       RETURNING id, department_id, name, is_active`,
      [name?.trim().toUpperCase(), is_active, req.params.sectionId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Section not found' });
    await auditLog(req.trainer.id, 'UPDATE_SECTION', 'section', req.params.sectionId, req.body, req.ip);
    res.json({ section: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/departments/sections/:sectionId  — soft delete
router.delete('/sections/:sectionId', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    await pool.query('UPDATE sections SET is_active = false WHERE id = $1', [req.params.sectionId]);
    await auditLog(req.trainer.id, 'DEACTIVATE_SECTION', 'section', req.params.sectionId, {}, req.ip);
    res.json({ message: 'Section deactivated' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
