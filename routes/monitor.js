const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { authenticate, auditLog } = require('../middleware/auth');

// GET /api/monitor/:examId — live exam stats (10s poll from frontend)
router.get('/:examId', authenticate, async (req, res) => {
  try {
    const stats = await pool.query(
      `SELECT COUNT(*) as total,
         COUNT(*) FILTER (WHERE status='active') as active,
         COUNT(*) FILTER (WHERE status IN ('submitted','auto_submitted')) as submitted,
         COUNT(*) FILTER (WHERE is_flagged=true) as flagged,
         COUNT(*) FILTER (WHERE status NOT IN ('active','submitted','auto_submitted','blocked')) as not_joined
       FROM student_sessions WHERE exam_id=$1`,
      [req.params.examId]
    );
    const students = await pool.query(
      `SELECT ss.id, ss.name, ss.roll_number, ss.department, ss.section,
         ss.started_at, ss.status, ss.is_flagged,
         (SELECT COUNT(*) FROM student_answers sa WHERE sa.session_id=ss.id AND sa.selected_option IS NOT NULL) as answered,
         (SELECT COUNT(*) FROM violations v WHERE v.session_id=ss.id AND v.violation_type='tab_switch') as tab_switches,
         (SELECT COUNT(*) FROM violations v WHERE v.session_id=ss.id AND v.violation_type='split_screen') as split_screens,
         (SELECT COUNT(*) FROM violations v WHERE v.session_id=ss.id) as total_violations,
         (SELECT MAX(pinged_at) FROM heartbeats hb WHERE hb.session_id=ss.id) as last_heartbeat
       FROM student_sessions ss WHERE ss.exam_id=$1
       ORDER BY ss.is_flagged DESC, ss.started_at ASC`,
      [req.params.examId]
    );
    const exam = await pool.query('SELECT title, duration_minutes, start_time, status, total_questions FROM exams WHERE id=$1', [req.params.examId]);
    res.json({ exam: exam.rows[0], stats: stats.rows[0], students: students.rows });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// POST /api/monitor/:examId/extend-time
router.post('/:examId/extend-time', authenticate, async (req, res) => {
  const { session_id, extra_minutes } = req.body;
  if (!session_id || !extra_minutes) return res.status(400).json({ error: 'session_id and extra_minutes required' });
  try {
    await pool.query(
      "INSERT INTO violations (session_id,violation_type,details) VALUES ($1,'time_extended',$2)",
      [session_id, JSON.stringify({ extra_minutes, granted_by: req.trainer.name, at: new Date() })]
    );
    await auditLog(req.trainer.id, 'EXTEND_TIME', 'session', session_id, { extra_minutes }, req.ip);
    res.json({ message: extra_minutes + ' minutes added' });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// POST /api/monitor/block-student
router.post('/block-student', authenticate, async (req, res) => {
  const { session_id } = req.body;
  try {
    await pool.query("UPDATE student_sessions SET status='blocked' WHERE id=$1", [session_id]);
    await auditLog(req.trainer.id, 'BLOCK_STUDENT', 'session', session_id, {}, req.ip);
    res.json({ message: 'Student blocked' });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// POST /api/monitor/unlock-student
router.post('/unlock-student', authenticate, async (req, res) => {
  const { session_id } = req.body;
  try {
    await pool.query("UPDATE student_sessions SET status='active' WHERE id=$1", [session_id]);
    await auditLog(req.trainer.id, 'UNLOCK_STUDENT', 'session', session_id, {}, req.ip);
    res.json({ message: 'Student unlocked' });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// GET /api/monitor/:examId/check-extension/:sessionToken
router.get('/:examId/check-extension/:sessionToken', async (req, res) => {
  try {
    const sess = await pool.query('SELECT id, status FROM student_sessions WHERE session_token=$1', [req.params.sessionToken]);
    if (!sess.rows.length) return res.status(404).json({ error: 'Session not found' });
    if (sess.rows[0].status === 'blocked') return res.json({ blocked: true });
    const ext = await pool.query(
      "SELECT details FROM violations WHERE session_id=$1 AND violation_type='time_extended' ORDER BY occurred_at DESC LIMIT 1",
      [sess.rows[0].id]
    );
    const extra = ext.rows.length ? ext.rows[0].details.extra_minutes : 0;
    res.json({ blocked: false, extra_minutes: extra });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

module.exports = router;
