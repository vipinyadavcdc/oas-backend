const express = require('express');
const router  = express.Router();
const pool    = require('../db/pool');
const { authenticate, requireSuperAdmin, auditLog } = require('../middleware/auth');

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC — no auth (student entry page)
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/departments?university=MRIIRS
router.get('/', async (req, res) => {
  try {
    const { university } = req.query;
    const r = await pool.query(
      `SELECT id, name, university FROM departments
       WHERE is_active = true ${university ? 'AND university = $1' : ''}
       ORDER BY name ASC`,
      university ? [university] : []
    );
    res.json({ departments: r.rows });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// GET /api/departments/tree  — full active tree (MUST be before /:id)
router.get('/tree', async (req, res) => {
  try {
    const depts = await pool.query(`SELECT id, name, university FROM departments WHERE is_active=true ORDER BY university, name`);
    const sems  = await pool.query(`SELECT id, department_id, number FROM semesters WHERE is_active=true ORDER BY number`);
    const sects = await pool.query(`SELECT id, semester_id, name FROM sections WHERE is_active=true ORDER BY name`);
    const tree = depts.rows.map(d => ({
      ...d,
      semesters: sems.rows.filter(s => s.department_id === d.id).map(s => ({
        ...s, sections: sects.rows.filter(sc => sc.semester_id === s.id)
      }))
    }));
    res.json({ tree: { MRIIRS: tree.filter(d => d.university==='MRIIRS'), MRU: tree.filter(d => d.university==='MRU') } });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// GET /api/departments/all  — with inactive, admin only (MUST be before /:id)
router.get('/all', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const depts = await pool.query(`SELECT id, name, university, is_active, created_at FROM departments ORDER BY university, name`);
    const sems  = await pool.query(`SELECT id, department_id, number, is_active FROM semesters ORDER BY department_id, number`);
    const sects = await pool.query(`SELECT id, semester_id, name, is_active FROM sections ORDER BY name`);
    const result = depts.rows.map(d => ({
      ...d,
      semesters: sems.rows.filter(s => s.department_id===d.id).map(s => ({
        ...s, sections: sects.rows.filter(sc => sc.semester_id===s.id)
      }))
    }));
    res.json({ departments: result });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// PATCH /api/departments/sections/:id  (MUST be before /:id)
router.patch('/sections/:sectionId', authenticate, requireSuperAdmin, async (req, res) => {
  const { name, is_active } = req.body;
  try {
    const r = await pool.query(
      `UPDATE sections SET name=COALESCE($1,name), is_active=COALESCE($2,is_active)
       WHERE id=$3 RETURNING id, semester_id, name, is_active`,
      [name?.trim().toUpperCase(), is_active, req.params.sectionId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Section not found' });
    await auditLog(req.trainer.id, 'UPDATE_SECTION', 'section', req.params.sectionId, req.body, req.ip);
    res.json({ section: r.rows[0] });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// DELETE /api/departments/sections/:id  (MUST be before /:id)
router.delete('/sections/:sectionId', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    await pool.query('UPDATE sections SET is_active=false WHERE id=$1', [req.params.sectionId]);
    await auditLog(req.trainer.id, 'DEACTIVATE_SECTION', 'section', req.params.sectionId, {}, req.ip);
    res.json({ message: 'Section deactivated' });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// PATCH /api/departments/semesters/:id  (MUST be before /:id)
router.patch('/semesters/:semesterId', authenticate, requireSuperAdmin, async (req, res) => {
  const { is_active } = req.body;
  try {
    const r = await pool.query(
      `UPDATE semesters SET is_active=COALESCE($1,is_active) WHERE id=$2
       RETURNING id, department_id, number, is_active`,
      [is_active, req.params.semesterId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Semester not found' });
    await auditLog(req.trainer.id, 'UPDATE_SEMESTER', 'semester', req.params.semesterId, req.body, req.ip);
    res.json({ semester: r.rows[0] });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// POST /api/departments/semesters/:id/sections  (MUST be before /:id)
router.post('/semesters/:semesterId/sections', authenticate, requireSuperAdmin, async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'section name required' });
  try {
    const sem = await pool.query('SELECT id FROM semesters WHERE id=$1', [req.params.semesterId]);
    if (!sem.rows.length) return res.status(404).json({ error: 'Semester not found' });
    const r = await pool.query(
      `INSERT INTO sections (semester_id, name) VALUES ($1, $2) RETURNING id, semester_id, name, is_active`,
      [req.params.semesterId, name.trim().toUpperCase()]
    );
    await auditLog(req.trainer.id, 'CREATE_SECTION', 'section', r.rows[0].id, { name }, req.ip);
    res.status(201).json({ section: r.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Section already exists in this semester' });
    res.status(500).json({ error: 'Server error' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// DYNAMIC /:id — MUST BE LAST
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/departments/:id/semesters — public
router.get('/:id/semesters', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, number FROM semesters WHERE department_id=$1 AND is_active=true ORDER BY number ASC`,
      [req.params.id]
    );
    res.json({ semesters: r.rows });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// POST /api/departments/:id/semesters
router.post('/:id/semesters', authenticate, requireSuperAdmin, async (req, res) => {
  const { number } = req.body;
  if (!number) return res.status(400).json({ error: 'semester number required' });
  try {
    const dept = await pool.query('SELECT id FROM departments WHERE id=$1', [req.params.id]);
    if (!dept.rows.length) return res.status(404).json({ error: 'Department not found' });
    const r = await pool.query(
      `INSERT INTO semesters (department_id, number) VALUES ($1, $2) RETURNING id, department_id, number, is_active`,
      [req.params.id, parseInt(number)]
    );
    await auditLog(req.trainer.id, 'CREATE_SEMESTER', 'semester', r.rows[0].id, { number }, req.ip);
    res.status(201).json({ semester: { ...r.rows[0], sections: [] } });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Semester already exists in this department' });
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/departments
router.post('/', authenticate, requireSuperAdmin, async (req, res) => {
  const { name, university } = req.body;
  if (!name || !university) return res.status(400).json({ error: 'name and university required' });
  if (!['MRIIRS','MRU'].includes(university)) return res.status(400).json({ error: 'university must be MRIIRS or MRU' });
  try {
    const r = await pool.query(
      `INSERT INTO departments (name, university) VALUES ($1, $2) RETURNING id, name, university, is_active`,
      [name.trim(), university]
    );
    await auditLog(req.trainer.id, 'CREATE_DEPARTMENT', 'department', r.rows[0].id, { name, university }, req.ip);
    res.status(201).json({ department: { ...r.rows[0], semesters: [] } });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Department already exists for this university' });
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/departments/:id
router.patch('/:id', authenticate, requireSuperAdmin, async (req, res) => {
  const { name, is_active } = req.body;
  try {
    const r = await pool.query(
      `UPDATE departments SET name=COALESCE($1,name), is_active=COALESCE($2,is_active)
       WHERE id=$3 RETURNING id, name, university, is_active`,
      [name?.trim(), is_active, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Department not found' });
    await auditLog(req.trainer.id, 'UPDATE_DEPARTMENT', 'department', req.params.id, req.body, req.ip);
    res.json({ department: r.rows[0] });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// DELETE /api/departments/:id
router.delete('/:id', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    await pool.query('UPDATE departments SET is_active=false WHERE id=$1', [req.params.id]);
    await auditLog(req.trainer.id, 'DEACTIVATE_DEPARTMENT', 'department', req.params.id, {}, req.ip);
    res.json({ message: 'Department deactivated' });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

module.exports = router;
