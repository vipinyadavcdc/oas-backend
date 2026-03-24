const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { authenticate, auditLog } = require('../middleware/auth');

// GET /api/templates
router.get('/', authenticate, async (req, res) => {
  try {
    const cond = req.trainer.role !== 'super_admin' ? 'WHERE trainer_id=$1' : '';
    const params = req.trainer.role !== 'super_admin' ? [req.trainer.id] : [];
    const result = await pool.query(
      'SELECT t.*, tr.name as trainer_name FROM exam_templates t LEFT JOIN trainers tr ON t.trainer_id=tr.id ' + cond + ' ORDER BY t.created_at DESC',
      params
    );
    res.json({ templates: result.rows });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// POST /api/templates
router.post('/', authenticate, async (req, res) => {
  const { name, exam_type, university, department, duration_minutes, marks_per_question, negative_marking, negative_marks, aptitude_count, verbal_count, randomize_questions, randomize_options } = req.body;
  if (!name || !exam_type) return res.status(400).json({ error: 'name and exam_type required' });
  try {
    const result = await pool.query(
      'INSERT INTO exam_templates (trainer_id,name,exam_type,university,department,duration_minutes,marks_per_question,negative_marking,negative_marks,aptitude_count,verbal_count,randomize_questions,randomize_options) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *',
      [req.trainer.id, name, exam_type, university||'BOTH', department||null, duration_minutes||60, marks_per_question||1, negative_marking||false, negative_marks||0.25, aptitude_count||15, verbal_count||10, randomize_questions!==false, randomize_options!==false]
    );
    await auditLog(req.trainer.id, 'CREATE_TEMPLATE', 'template', result.rows[0].id, { name }, req.ip);
    res.status(201).json({ template: result.rows[0] });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// GET /api/templates/:id
router.get('/:id', authenticate, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM exam_templates WHERE id=$1', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Template not found' });
    res.json({ template: result.rows[0] });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// DELETE /api/templates/:id
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const check = await pool.query('SELECT trainer_id FROM exam_templates WHERE id=$1', [req.params.id]);
    if (!check.rows.length) return res.status(404).json({ error: 'Not found' });
    if (req.trainer.role !== 'super_admin' && check.rows[0].trainer_id !== req.trainer.id)
      return res.status(403).json({ error: 'Not authorized' });
    await pool.query('DELETE FROM exam_templates WHERE id=$1', [req.params.id]);
    res.json({ message: 'Template deleted' });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

module.exports = router;
