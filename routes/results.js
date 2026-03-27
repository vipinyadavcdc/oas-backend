const express = require('express')
const router = express.Router()
const XLSX = require('xlsx')
const pool = require('../db/pool')
const { authenticate } = require('../middleware/auth')

// IMPORTANT: specific routes MUST come before /:examId wildcard

// GET /api/results/student/:rollNumber/history
router.get('/student/:rollNumber/history', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         ss.id as session_id, ss.name, ss.roll_number, ss.department, ss.section,
         ss.started_at, ss.submitted_at, ss.time_taken_seconds, ss.status, ss.is_flagged,
         e.title as exam_title, e.exam_type, e.id as exam_id,
         er.final_score, er.max_score, er.percentage, er.correct, er.incorrect,
         er.aptitude_score, er.verbal_score,
         (SELECT COUNT(*) FROM violations v WHERE v.session_id = ss.id) as violations
       FROM student_sessions ss
       JOIN exams e ON ss.exam_id = e.id
       LEFT JOIN exam_results er ON er.session_id = ss.id
       WHERE UPPER(ss.roll_number) = $1
       ORDER BY ss.started_at DESC`,
      [req.params.rollNumber.toUpperCase()]
    )
    res.json({ history: result.rows })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Server error' })
  }
})

// GET /api/results/:examId
router.get('/:examId', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         ss.id as session_id, ss.name, ss.roll_number, ss.email, ss.mobile,
         ss.university, ss.department, ss.section,
         ss.started_at, ss.submitted_at, ss.time_taken_seconds,
         ss.status, ss.is_flagged, ss.ip_address,
         ss.current_section, ss.aptitude_submitted_at, ss.verbal_submitted_at,
         ss.aptitude_time_used, ss.verbal_time_used,
         er.total_questions, er.attempted, er.correct, er.incorrect, er.skipped,
         er.final_score, er.max_score, er.percentage,
         er.aptitude_score, er.verbal_score,
         (SELECT COUNT(*) FROM violations v WHERE v.session_id = ss.id) as violation_count,
         (SELECT COUNT(*) FROM violations v WHERE v.session_id = ss.id AND v.violation_type = 'tab_switch') as tab_switches,
         (SELECT COUNT(*) FROM violations v WHERE v.session_id = ss.id AND v.violation_type = 'window_blur') as window_blurs,
         (SELECT COUNT(*) FROM violations v WHERE v.session_id = ss.id AND v.violation_type = 'split_screen') as split_screen_count
       FROM student_sessions ss
       LEFT JOIN exam_results er ON er.session_id = ss.id
       WHERE ss.exam_id = $1
       ORDER BY er.final_score DESC NULLS LAST`,
      [req.params.examId]
    )
    res.json({ results: result.rows })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Server error' })
  }
})

// GET /api/results/:examId/most-missed
router.get('/:examId/most-missed', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         q.id, q.question_text, q.topic, q.section, q.difficulty,
         COUNT(sa.id) as total_attempts,
         COUNT(sa.id) FILTER (WHERE sa.selected_option IS NOT NULL) as answered,
         COUNT(sa.id) FILTER (WHERE sa.selected_option = q.correct_option) as correct_count,
         COUNT(sa.id) FILTER (WHERE sa.selected_option != q.correct_option AND sa.selected_option IS NOT NULL) as wrong_count,
         COUNT(sa.id) FILTER (WHERE sa.selected_option IS NULL) as skipped_count,
         ROUND(
           COUNT(sa.id) FILTER (WHERE sa.selected_option = q.correct_option)::numeric /
           NULLIF(COUNT(sa.id) FILTER (WHERE sa.selected_option IS NOT NULL), 0) * 100, 1
         ) as accuracy_pct,
         ROUND(AVG(sa.time_spent_seconds) FILTER (WHERE sa.time_spent_seconds > 0), 1) as avg_time_secs
       FROM exam_questions eq
       JOIN questions q ON eq.question_id = q.id
       LEFT JOIN student_answers sa ON sa.question_id = q.id
         AND sa.session_id IN (SELECT id FROM student_sessions WHERE exam_id = $1)
       WHERE eq.exam_id = $1
       GROUP BY q.id, q.question_text, q.topic, q.section, q.difficulty
       ORDER BY accuracy_pct ASC NULLS FIRST`,
      [req.params.examId]
    )
    res.json({ questions: result.rows })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Server error' })
  }
})

// GET /api/results/:examId/batch-comparison
router.get('/:examId/batch-comparison', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         ss.department, ss.section, ss.university,
         COUNT(ss.id) as student_count,
         ROUND(AVG(er.percentage), 1) as avg_percentage,
         ROUND(AVG(er.aptitude_score), 2) as avg_aptitude,
         ROUND(AVG(er.verbal_score), 2) as avg_verbal,
         MAX(er.percentage) as top_score,
         MIN(er.percentage) as low_score,
         COUNT(ss.id) FILTER (WHERE ss.is_flagged) as flagged_count
       FROM student_sessions ss
       LEFT JOIN exam_results er ON er.session_id = ss.id
       WHERE ss.exam_id = $1 AND ss.status IN ('submitted','auto_submitted')
       GROUP BY ss.department, ss.section, ss.university
       ORDER BY avg_percentage DESC NULLS LAST`,
      [req.params.examId]
    )
    res.json({ batches: result.rows })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Server error' })
  }
})

// GET /api/results/:examId/export
router.get('/:examId/export', authenticate, async (req, res) => {
  try {
    const examRes = await pool.query('SELECT title, exam_type FROM exams WHERE id=$1', [req.params.examId])
    if (!examRes.rows.length) return res.status(404).json({ error: 'Exam not found' })
    const exam = examRes.rows[0]
    const result = await pool.query(
      `SELECT
         ss.name as "Student Name", ss.roll_number as "Roll Number", ss.participant_id as "Participant ID",
         ss.email as "Email", ss.mobile as "Mobile",
         ss.university as "University", ss.department as "Department", ss.section as "Section",
         TO_CHAR(ss.started_at, 'DD-Mon-YYYY HH24:MI') as "Start Time",
         TO_CHAR(ss.submitted_at, 'DD-Mon-YYYY HH24:MI') as "Submit Time",
         ROUND(ss.time_taken_seconds::numeric/60,1) as "Time Taken (mins)",
         ss.status as "Status",
         CASE WHEN ss.is_flagged THEN 'FLAGGED' ELSE 'OK' END as "Flag Status",
         er.total_questions as "Total Q", er.attempted as "Attempted",
         er.correct as "Correct", er.incorrect as "Incorrect", er.skipped as "Skipped",
         er.aptitude_score as "Aptitude Score", er.verbal_score as "Verbal Score",
         er.final_score as "Final Score", er.max_score as "Max Score",
         ROUND(er.percentage,2) as "Percentage %",
         (SELECT COUNT(*) FROM violations v WHERE v.session_id=ss.id AND v.violation_type='tab_switch') as "Tab Switches",
         (SELECT COUNT(*) FROM violations v WHERE v.session_id=ss.id AND v.violation_type='split_screen') as "Split Screen",
         (SELECT COUNT(*) FROM violations v WHERE v.session_id=ss.id) as "Total Violations",
         ss.ip_address as "IP Address"
       FROM student_sessions ss
       LEFT JOIN exam_results er ON er.session_id = ss.id
       WHERE ss.exam_id = $1
       ORDER BY er.final_score DESC NULLS LAST`,
      [req.params.examId]
    )
    const wb = XLSX.utils.book_new()
    const ws = XLSX.utils.json_to_sheet(result.rows)
    ws['!cols'] = result.rows.length ? Object.keys(result.rows[0]).map(k => ({ wch: Math.max(k.length, 12) })) : []
    XLSX.utils.book_append_sheet(wb, ws, 'Results')
    const filename = `${exam.title}_Results.xlsx`.replace(/[^a-z0-9_.-]/gi, '_')
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
    res.setHeader('Content-Disposition', `attachment; filename=${filename}`)
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.send(buf)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Server error' })
  }
})

module.exports = router
