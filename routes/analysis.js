// CDC OAS — Analysis Routes
// Only accessible by EMP001 (Vipin) and EMP002 (Ankur)

const express = require('express')
const router  = express.Router()
const pool    = require('../db/pool')
const { authenticate } = require('../middleware/auth')

// Middleware — only Vipin (EMP001) and Ankur (EMP002)
const analysisOnly = (req, res, next) => {
  const allowed = ['vipinyadav.cdc@mriu.edu.in', 'ankurkumaraggarwal@mru.edu.in']
  if (!allowed.includes(req.trainer?.email?.toLowerCase())) {
    return res.status(403).json({ error: 'Access denied' })
  }
  next()
}

// ── GET /api/analysis/exams — list all exams for dropdown ────────────────────
router.get('/exams', authenticate, analysisOnly, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT e.id, e.title, e.exam_type, e.university, e.created_at,
              e.total_questions, e.marks_per_question, e.negative_marking,
              e.aptitude_time_minutes, e.verbal_time_minutes,
              COUNT(ss.id) as student_count
       FROM exams e
       LEFT JOIN student_sessions ss ON ss.exam_id = e.id
         AND ss.status IN ('submitted','auto_submitted')
       WHERE e.status IN ('live','ended','published')
       GROUP BY e.id
       ORDER BY e.created_at DESC`
    )
    res.json({ exams: result.rows })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Server error' })
  }
})

// ── GET /api/analysis/:examId/overview ──────────────────────────────────────
router.get('/:examId/overview', authenticate, analysisOnly, async (req, res) => {
  const { examId } = req.params
  const { cutoff = 40 } = req.query
  try {
    const exam = await pool.query('SELECT * FROM exams WHERE id=$1', [examId])
    if (!exam.rows.length) return res.status(404).json({ error: 'Exam not found' })

    const stats = await pool.query(
      `SELECT
         COUNT(*)                                          as total_students,
         COUNT(*) FILTER (WHERE er.percentage >= $2)      as passed,
         COUNT(*) FILTER (WHERE er.percentage < $2)       as failed,
         ROUND(AVG(er.percentage),1)                      as avg_percentage,
         ROUND(AVG(er.aptitude_score),2)                  as avg_aptitude,
         ROUND(AVG(er.verbal_score),2)                    as avg_verbal,
         MAX(er.percentage)                               as highest,
         MIN(er.percentage)                               as lowest,
         COUNT(*) FILTER (WHERE ss.is_flagged)            as flagged_count,
         ROUND(AVG(er.final_score),2)                     as avg_score,
         SUM(er.attempted)                                as total_attempted,
         SUM(er.correct)                                  as total_correct,
         SUM(er.incorrect)                                as total_incorrect,
         ROUND(AVG(ss.time_taken_seconds/60.0),1)         as avg_time_minutes
       FROM student_sessions ss
       JOIN exam_results er ON er.session_id = ss.id
       WHERE ss.exam_id=$1 AND ss.status IN ('submitted','auto_submitted')`,
      [examId, cutoff]
    )

    // Score distribution buckets: 0-20, 20-40, 40-60, 60-80, 80-100
    const dist = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE er.percentage < 20)              as bucket_0_20,
         COUNT(*) FILTER (WHERE er.percentage >= 20 AND er.percentage < 40) as bucket_20_40,
         COUNT(*) FILTER (WHERE er.percentage >= 40 AND er.percentage < 60) as bucket_40_60,
         COUNT(*) FILTER (WHERE er.percentage >= 60 AND er.percentage < 80) as bucket_60_80,
         COUNT(*) FILTER (WHERE er.percentage >= 80)             as bucket_80_100
       FROM student_sessions ss
       JOIN exam_results er ON er.session_id = ss.id
       WHERE ss.exam_id=$1 AND ss.status IN ('submitted','auto_submitted')`,
      [examId]
    )

    res.json({
      exam:         exam.rows[0],
      stats:        stats.rows[0],
      distribution: dist.rows[0],
      cutoff:       parseInt(cutoff)
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Server error' })
  }
})

// ── GET /api/analysis/:examId/rankings ──────────────────────────────────────
router.get('/:examId/rankings', authenticate, analysisOnly, async (req, res) => {
  const { examId } = req.params
  const { cutoff = 40 } = req.query
  try {
    const result = await pool.query(
      `SELECT
         ss.name, ss.roll_number, ss.department, ss.section, ss.university,
         ss.is_flagged, ss.resume_count,
         er.final_score, er.max_score, er.percentage,
         er.aptitude_score, er.verbal_score,
         er.correct, er.incorrect, er.attempted, er.total_questions,
         ss.time_taken_seconds,
         (SELECT COUNT(*) FROM violations v WHERE v.session_id = ss.id) as violations,
         RANK() OVER (ORDER BY er.percentage DESC NULLS LAST) as rank
       FROM student_sessions ss
       JOIN exam_results er ON er.session_id = ss.id
       WHERE ss.exam_id=$1 AND ss.status IN ('submitted','auto_submitted')
       ORDER BY er.percentage DESC NULLS LAST`,
      [examId]
    )
    res.json({ rankings: result.rows, cutoff: parseInt(cutoff) })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Server error' })
  }
})

// ── GET /api/analysis/:examId/sections ──────────────────────────────────────
router.get('/:examId/sections', authenticate, analysisOnly, async (req, res) => {
  const { examId } = req.params
  try {
    const result = await pool.query(
      `SELECT
         ss.name, ss.roll_number, ss.department,
         er.aptitude_score, er.verbal_score, er.percentage,
         e.aptitude_count, e.verbal_count,
         e.marks_per_question
       FROM student_sessions ss
       JOIN exam_results er ON er.session_id = ss.id
       JOIN exams e ON e.id = ss.exam_id
       WHERE ss.exam_id=$1 AND ss.status IN ('submitted','auto_submitted')
       ORDER BY er.percentage DESC`,
      [examId]
    )

    // Section averages
    const avgs = await pool.query(
      `SELECT
         ROUND(AVG(er.aptitude_score),2) as avg_aptitude,
         ROUND(AVG(er.verbal_score),2)   as avg_verbal,
         e.aptitude_count, e.verbal_count, e.marks_per_question
       FROM student_sessions ss
       JOIN exam_results er ON er.session_id = ss.id
       JOIN exams e ON e.id = ss.exam_id
       WHERE ss.exam_id=$1 AND ss.status IN ('submitted','auto_submitted')
       GROUP BY e.aptitude_count, e.verbal_count, e.marks_per_question`,
      [examId]
    )

    res.json({ students: result.rows, averages: avgs.rows[0] || {} })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Server error' })
  }
})

// ── GET /api/analysis/:examId/departments ───────────────────────────────────
router.get('/:examId/departments', authenticate, analysisOnly, async (req, res) => {
  const { examId } = req.params
  const { cutoff = 40 } = req.query
  try {
    const result = await pool.query(
      `SELECT
         ss.department,
         ss.university,
         COUNT(*)                                         as total,
         ROUND(AVG(er.percentage),1)                     as avg_percentage,
         ROUND(AVG(er.aptitude_score),2)                 as avg_aptitude,
         ROUND(AVG(er.verbal_score),2)                   as avg_verbal,
         MAX(er.percentage)                              as highest,
         MIN(er.percentage)                              as lowest,
         COUNT(*) FILTER (WHERE er.percentage >= $2)     as passed,
         COUNT(*) FILTER (WHERE ss.is_flagged)           as flagged
       FROM student_sessions ss
       JOIN exam_results er ON er.session_id = ss.id
       WHERE ss.exam_id=$1 AND ss.status IN ('submitted','auto_submitted')
       GROUP BY ss.department, ss.university
       ORDER BY avg_percentage DESC NULLS LAST`,
      [examId, cutoff]
    )
    res.json({ departments: result.rows, cutoff: parseInt(cutoff) })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Server error' })
  }
})

// ── GET /api/analysis/:examId/questions ─────────────────────────────────────
router.get('/:examId/questions', authenticate, analysisOnly, async (req, res) => {
  const { examId } = req.params
  try {
    const result = await pool.query(
      `SELECT
         q.id, q.question_text, q.topic, q.section, q.difficulty, q.correct_option,
         COUNT(sa.id)                                                          as total_attempts,
         COUNT(sa.id) FILTER (WHERE sa.selected_option = q.correct_option)    as correct_count,
         COUNT(sa.id) FILTER (WHERE sa.selected_option != q.correct_option
                               AND sa.selected_option IS NOT NULL)            as wrong_count,
         COUNT(sa.id) FILTER (WHERE sa.selected_option IS NULL)               as skipped_count,
         ROUND(
           COUNT(sa.id) FILTER (WHERE sa.selected_option = q.correct_option)::numeric /
           NULLIF(COUNT(sa.id) FILTER (WHERE sa.selected_option IS NOT NULL),0) * 100, 1
         )                                                                     as accuracy_pct,
         ROUND(AVG(sa.time_spent_seconds) FILTER (WHERE sa.time_spent_seconds > 0), 1) as avg_time_secs
       FROM exam_questions eq
       JOIN questions q ON eq.question_id = q.id
       LEFT JOIN student_answers sa ON sa.question_id = q.id
         AND sa.session_id IN (
           SELECT id FROM student_sessions
           WHERE exam_id=$1 AND status IN ('submitted','auto_submitted')
         )
       WHERE eq.exam_id=$1
       GROUP BY q.id, q.question_text, q.topic, q.section, q.difficulty, q.correct_option
       ORDER BY accuracy_pct ASC NULLS FIRST`,
      [examId]
    )
    res.json({ questions: result.rows })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Server error' })
  }
})

// ── GET /api/analysis/:examId/integrity ─────────────────────────────────────
router.get('/:examId/integrity', authenticate, analysisOnly, async (req, res) => {
  const { examId } = req.params
  try {
    const result = await pool.query(
      `SELECT
         ss.name, ss.roll_number, ss.department, ss.ip_address,
         ss.is_flagged, ss.resume_count, ss.device_fingerprint,
         er.percentage,
         COUNT(v.id)                                                           as total_violations,
         COUNT(v.id) FILTER (WHERE v.violation_type = 'tab_switch')           as tab_switches,
         COUNT(v.id) FILTER (WHERE v.violation_type = 'fullscreen_exit')      as fullscreen_exits,
         COUNT(v.id) FILTER (WHERE v.violation_type = 'split_screen'
                              OR v.violation_type = 'split_screen_or_ai')     as split_screens,
         COUNT(v.id) FILTER (WHERE v.violation_type = 'devtools_open')        as devtools,
         COUNT(v.id) FILTER (WHERE v.violation_type = 'window_blur')          as window_blurs,
         COUNT(sa_fast.id)                                                     as fast_answers
       FROM student_sessions ss
       LEFT JOIN exam_results er ON er.session_id = ss.id
       LEFT JOIN violations v ON v.session_id = ss.id
       LEFT JOIN student_answers sa_fast ON sa_fast.session_id = ss.id
         AND sa_fast.flagged_fast = true
       WHERE ss.exam_id=$1 AND ss.status IN ('submitted','auto_submitted')
       GROUP BY ss.id, ss.name, ss.roll_number, ss.department,
                ss.ip_address, ss.is_flagged, ss.resume_count,
                ss.device_fingerprint, er.percentage
       ORDER BY total_violations DESC, ss.is_flagged DESC`,
      [examId]
    )

    // Proxy alerts for this exam
    const proxies = await pool.query(
      `SELECT pa.*, ss1.name as name_1, ss1.roll_number as roll_1
       FROM proxy_alerts pa
       LEFT JOIN student_sessions ss1 ON pa.session_id_1 = ss1.id
       WHERE pa.exam_id=$1
       ORDER BY pa.created_at DESC`,
      [examId]
    )

    res.json({ students: result.rows, proxy_alerts: proxies.rows })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Server error' })
  }
})

// ── GET /api/analysis/trends/:rollNumber — student trend across exams ────────
router.get('/trends/:rollNumber', authenticate, analysisOnly, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         e.title, e.exam_type, e.created_at,
         er.percentage, er.aptitude_score, er.verbal_score,
         er.final_score, er.max_score,
         ss.time_taken_seconds, ss.is_flagged
       FROM student_sessions ss
       JOIN exams e ON ss.exam_id = e.id
       JOIN exam_results er ON er.session_id = ss.id
       WHERE UPPER(ss.roll_number) = $1
         AND ss.status IN ('submitted','auto_submitted')
       ORDER BY e.created_at ASC`,
      [req.params.rollNumber.toUpperCase()]
    )
    res.json({ trends: result.rows })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Server error' })
  }
})

// ── GET /api/analysis/:examId/full-data — all data for AI report ─────────────
router.get('/:examId/full-data', authenticate, analysisOnly, async (req, res) => {
  const { examId } = req.params
  const { cutoff = 40 } = req.query
  try {
    const [exam, overview, sections, departments, questions, integrity] = await Promise.all([
      pool.query('SELECT * FROM exams WHERE id=$1', [examId]),
      pool.query(
        `SELECT COUNT(*) as total, ROUND(AVG(er.percentage),1) as avg_pct,
                ROUND(AVG(er.aptitude_score),2) as avg_apt,
                ROUND(AVG(er.verbal_score),2) as avg_ver,
                MAX(er.percentage) as highest, MIN(er.percentage) as lowest,
                COUNT(*) FILTER (WHERE er.percentage >= $2) as passed,
                COUNT(*) FILTER (WHERE ss.is_flagged) as flagged
         FROM student_sessions ss JOIN exam_results er ON er.session_id=ss.id
         WHERE ss.exam_id=$1 AND ss.status IN ('submitted','auto_submitted')`,
        [examId, cutoff]
      ),
      pool.query(
        `SELECT ss.department, COUNT(*) as total,
                ROUND(AVG(er.percentage),1) as avg_pct,
                COUNT(*) FILTER (WHERE er.percentage >= $2) as passed
         FROM student_sessions ss JOIN exam_results er ON er.session_id=ss.id
         WHERE ss.exam_id=$1 AND ss.status IN ('submitted','auto_submitted')
         GROUP BY ss.department ORDER BY avg_pct DESC`,
        [examId, cutoff]
      ),
      pool.query(
        `SELECT q.topic, q.section,
                ROUND(AVG(CASE WHEN sa.selected_option=q.correct_option THEN 100.0 ELSE 0 END),1) as accuracy
         FROM exam_questions eq JOIN questions q ON eq.question_id=q.id
         LEFT JOIN student_answers sa ON sa.question_id=q.id
           AND sa.session_id IN (SELECT id FROM student_sessions WHERE exam_id=$1 AND status IN ('submitted','auto_submitted'))
         WHERE eq.exam_id=$1
         GROUP BY q.topic, q.section ORDER BY accuracy ASC LIMIT 10`,
        [examId]
      ),
      pool.query(
        `SELECT COUNT(*) FILTER (WHERE ss.is_flagged) as flagged,
                COUNT(*) FILTER (WHERE v.violation_type='tab_switch') as tab_switches,
                COUNT(*) FILTER (WHERE v.violation_type='split_screen' OR v.violation_type='split_screen_or_ai') as split_screens,
                COUNT(*) FILTER (WHERE sa.flagged_fast=true) as fast_answers
         FROM student_sessions ss
         LEFT JOIN violations v ON v.session_id=ss.id
         LEFT JOIN student_answers sa ON sa.session_id=ss.id
         WHERE ss.exam_id=$1`,
        [examId]
      )
    ])

    res.json({
      exam:        exam.rows[0],
      overview:    overview.rows[0],
      departments: sections.rows,
      weak_topics: questions.rows,
      integrity:   integrity.rows[0],
      cutoff:      parseInt(cutoff)
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Server error' })
  }
})

// ── POST /api/analysis/ai-report — streaming AI report ──────────────────────
router.post('/ai-report', authenticate, analysisOnly, async (req, res) => {
  const { prompt } = req.body
  if (!prompt) return res.status(400).json({ error: 'No prompt provided' })

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return res.status(500).json({ error: 'AI not configured. Add ANTHROPIC_API_KEY to Railway environment variables.' })
  }

  try {
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.flushHeaders()

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-20250514',
        max_tokens: 2500,
        stream:     true,
        messages:   [{ role: 'user', content: prompt }]
      })
    })

    if (!response.ok) {
      const errText = await response.text()
      res.write('data: ' + JSON.stringify({ error: errText }) + '\n\n')
      res.end()
      return
    }

    const reader  = response.body.getReader()
    const decoder = new TextDecoder()

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = decoder.decode(value)
      const lines = chunk.split('\n').filter(function(l) { return l.startsWith('data: ') })
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        try {
          const json = JSON.parse(line.slice(6))
          if (json.type === 'content_block_delta' && json.delta && json.delta.text) {
            res.write('data: ' + JSON.stringify({ text: json.delta.text }) + '\n\n')
          }
          if (json.type === 'message_stop') {
            res.write('data: [DONE]\n\n')
            res.end()
            return
          }
        } catch (e) {}
      }
    }
    res.write('data: [DONE]\n\n')
    res.end()
  } catch (err) {
    console.error('AI report error:', err)
    try {
      res.write('data: ' + JSON.stringify({ error: err.message }) + '\n\n')
      res.end()
    } catch (e) {}
  }
})

module.exports = router
