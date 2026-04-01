// CDC OAS — Psychometric Routes
// Integrated with existing OAS backend
// Only Vipin & Ankur can manage tests

const express  = require('express')
const router   = express.Router()
const pool     = require('../db/pool')
const { authenticate } = require('../middleware/auth')
const { calculateScores, generateParticipantId, generatePsyAccessCode } = require('../services/psyScoring')

// Access control — only Vipin & Ankur
const PSY_ADMIN_EMAILS = ['vipinyadav.cdc@mriu.edu.in', 'ankurkumaraggarwal@mru.edu.in']
const psyAdmin = (req, res, next) => {
  if (!PSY_ADMIN_EMAILS.includes(req.trainer?.email?.toLowerCase())) {
    return res.status(403).json({ error: 'Psychometric admin access required' })
  }
  next()
}

// ── TEST MANAGEMENT (Vipin & Ankur only) ─────────────────────────────────────

// Create psychometric test
router.post('/tests', authenticate, psyAdmin, async (req, res) => {
  try {
    const {
      title, description, program_tier,
      include_riasec, include_bigfive, include_interest,
      include_aptitude, include_eq, include_mi,
      include_values, include_learning,
      allow_skip_break, break_duration_seconds, aptitude_time_seconds
    } = req.body

    let code
    let attempts = 0
    do {
      code = generatePsyAccessCode()
      attempts++
    } while (attempts < 10 && (await pool.query('SELECT id FROM psy_tests WHERE access_code=$1', [code])).rows.length > 0)

    const result = await pool.query(
      `INSERT INTO psy_tests 
       (title, description, access_code, program_tier, created_by,
        include_riasec, include_bigfive, include_interest, include_aptitude,
        include_eq, include_mi, include_values, include_learning,
        allow_skip_break, break_duration_seconds, aptitude_time_seconds)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [title, description, code, program_tier || 'career', req.trainer.id,
       include_riasec !== false, include_bigfive !== false, include_interest !== false,
       include_aptitude !== false, include_eq !== false, include_mi !== false,
       include_values !== false, include_learning !== false,
       allow_skip_break !== false, break_duration_seconds || 120, aptitude_time_seconds || 1500]
    )
    res.status(201).json({ test: result.rows[0] })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to create test' })
  }
})

// Get all tests
router.get('/tests', authenticate, psyAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT t.*, tr.name as created_by_name,
              COUNT(DISTINCT s.id) as student_count,
              COUNT(DISTINCT CASE WHEN se.status='completed' THEN se.id END) as completed_count
       FROM psy_tests t
       LEFT JOIN trainers tr ON t.created_by = tr.id
       LEFT JOIN psy_students s ON s.test_id = t.id
       LEFT JOIN psy_sessions se ON se.test_id = t.id
       GROUP BY t.id, tr.name
       ORDER BY t.created_at DESC`
    )
    res.json({ tests: result.rows })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

// Update test
router.patch('/tests/:id', authenticate, psyAdmin, async (req, res) => {
  try {
    const { status, title, description } = req.body
    const result = await pool.query(
      `UPDATE psy_tests SET status=COALESCE($1,status), title=COALESCE($2,title), 
       description=COALESCE($3,description), updated_at=NOW()
       WHERE id=$4 RETURNING *`,
      [status, title, description, req.params.id]
    )
    res.json({ test: result.rows[0] })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

// ── STUDENT REGISTRATION & ACCESS ────────────────────────────────────────────

// Validate access code (before registration)
router.get('/validate/:code', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, title, program_tier, status,
              include_riasec, include_bigfive, include_interest,
              include_aptitude, include_eq, include_mi, include_values, include_learning,
              allow_skip_break, break_duration_seconds, aptitude_time_seconds
       FROM psy_tests WHERE access_code=$1 AND is_active=true`,
      [req.params.code.toUpperCase()]
    )
    if (!result.rows.length) return res.status(404).json({ error: 'Invalid access code' })
    const test = result.rows[0]
    if (test.status === 'closed') return res.status(403).json({ error: 'This assessment is closed' })
    res.json({ test })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

// Register student & start session
router.post('/register', async (req, res) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const {
      access_code, full_name, date_of_birth, gender,
      contact_number, email, city, state,
      student_type, institution_name,
      class_grade, stream, board,
      course_branch, year_of_study, university_name,
      father_name, father_occupation, father_contact, father_email,
      mother_name, mother_occupation, mother_contact, mother_email,
      current_career_thought, referral_source
    } = req.body

    // Validate test
    const testRes = await client.query(
      `SELECT * FROM psy_tests WHERE access_code=$1 AND is_active=true AND status != 'closed'`,
      [access_code.toUpperCase()]
    )
    if (!testRes.rows.length) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Invalid or closed access code' })
    }
    const test = testRes.rows[0]

    // Generate unique participant ID
    let participantId
    do {
      participantId = generateParticipantId()
    } while ((await client.query('SELECT id FROM psy_students WHERE participant_id=$1', [participantId])).rows.length > 0)

    // Create student record
    const studentRes = await client.query(
      `INSERT INTO psy_students 
       (participant_id, test_id, access_code, full_name, date_of_birth, gender,
        contact_number, email, city, state, student_type, institution_name,
        class_grade, stream, board, course_branch, year_of_study, university_name,
        father_name, father_occupation, father_contact, father_email,
        mother_name, mother_occupation, mother_contact, mother_email,
        current_career_thought, referral_source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)
       RETURNING *`,
      [participantId, test.id, access_code.toUpperCase(), full_name, date_of_birth, gender,
       contact_number, email, city, state, student_type, institution_name,
       class_grade, stream, board, course_branch, year_of_study, university_name,
       father_name, father_occupation, father_contact, father_email,
       mother_name, mother_occupation, mother_contact, mother_email,
       current_career_thought, referral_source]
    )
    const student = studentRes.rows[0]

    // Create session
    const sessionRes = await client.query(
      `INSERT INTO psy_sessions (student_id, test_id, program_tier, ip_address)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [student.id, test.id, test.program_tier, req.ip]
    )
    const session = sessionRes.rows[0]

    // Generate JWT token for student session
    const jwt = require('jsonwebtoken')
    const token = jwt.sign(
      { psy_student_id: student.id, psy_session_id: session.id, type: 'psy_student' },
      process.env.JWT_SECRET,
      { expiresIn: '8h' }
    )

    await client.query('COMMIT')
    res.status(201).json({
      token,
      student: { id: student.id, participant_id: student.participant_id, full_name: student.full_name },
      session: { id: session.id },
      test: { 
        id: test.id, title: test.title, program_tier: test.program_tier,
        include_riasec: test.include_riasec, include_bigfive: test.include_bigfive,
        include_interest: test.include_interest, include_aptitude: test.include_aptitude,
        include_eq: test.include_eq, include_mi: test.include_mi,
        include_values: test.include_values, include_learning: test.include_learning,
        allow_skip_break: test.allow_skip_break, break_duration_seconds: test.break_duration_seconds,
        aptitude_time_seconds: test.aptitude_time_seconds
      }
    })
  } catch (err) {
    await client.query('ROLLBACK')
    console.error(err)
    res.status(500).json({ error: 'Registration failed' })
  } finally {
    client.release()
  }
})

// ── ASSESSMENT FLOW ───────────────────────────────────────────────────────────

// Auth middleware for student sessions
const psyStudentAuth = (req, res, next) => {
  try {
    const jwt   = require('jsonwebtoken')
    const token = req.headers.authorization?.split(' ')[1]
    if (!token) return res.status(401).json({ error: 'No token' })
    const decoded = jwt.verify(token, process.env.JWT_SECRET)
    if (decoded.type !== 'psy_student') return res.status(401).json({ error: 'Invalid token' })
    req.psyStudent   = { id: decoded.psy_student_id }
    req.psySession   = { id: decoded.psy_session_id }
    next()
  } catch {
    res.status(401).json({ error: 'Invalid token' })
  }
}

// Save answer (auto-save on every question)
router.post('/answer', psyStudentAuth, async (req, res) => {
  try {
    const { question_id, dimension, scale, response_value, time_taken_seconds } = req.body
    await pool.query(
      `INSERT INTO psy_answers (session_id, student_id, question_id, dimension, scale, response_value, time_taken_seconds)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (session_id, question_id) DO UPDATE SET response_value=$5, time_taken_seconds=$6, answered_at=NOW()`,
      [req.psySession.id, req.psyStudent.id, question_id, dimension, scale, response_value, time_taken_seconds]
    )
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: 'Failed to save answer' })
  }
})

// Save batch answers
router.post('/answers/batch', psyStudentAuth, async (req, res) => {
  try {
    const { answers } = req.body
    for (const a of answers) {
      await pool.query(
        `INSERT INTO psy_answers (session_id, student_id, question_id, dimension, scale, response_value, time_taken_seconds)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (session_id, question_id) DO UPDATE SET response_value=$5, time_taken_seconds=$6, answered_at=NOW()`,
        [req.psySession.id, req.psyStudent.id, a.question_id, a.dimension, a.scale, a.response_value, a.time_taken_seconds]
      )
    }
    res.json({ success: true, count: answers.length })
  } catch (err) {
    res.status(500).json({ error: 'Failed to save answers' })
  }
})

// Update current module progress
router.patch('/session/progress', psyStudentAuth, async (req, res) => {
  try {
    const { current_module, completed_module, time_for_module } = req.body
    const session = await pool.query('SELECT * FROM psy_sessions WHERE id=$1', [req.psySession.id])
    const current = session.rows[0]
    
    const modulesCompleted = current.modules_completed || []
    if (completed_module && !modulesCompleted.includes(completed_module)) {
      modulesCompleted.push(completed_module)
    }
    
    const moduleTimes = current.module_times || {}
    if (completed_module && time_for_module) {
      moduleTimes[completed_module] = time_for_module
    }

    await pool.query(
      `UPDATE psy_sessions SET current_module=$1, modules_completed=$2, module_times=$3 WHERE id=$4`,
      [current_module, JSON.stringify(modulesCompleted), JSON.stringify(moduleTimes), req.psySession.id]
    )
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

// Complete assessment & trigger scoring
router.post('/complete', psyStudentAuth, async (req, res) => {
  try {
    const { total_time_seconds } = req.body

    // Get all answers
    const answersRes = await pool.query(
      'SELECT * FROM psy_answers WHERE session_id=$1', [req.psySession.id]
    )

    // Mark session complete
    await pool.query(
      `UPDATE psy_sessions SET status='completed', completed_at=NOW(), total_time_seconds=$1 WHERE id=$2`,
      [total_time_seconds, req.psySession.id]
    )

    // Run scoring engine
    const results = await calculateScores(req.psySession.id, req.psyStudent.id, answersRes.rows)

    res.json({ success: true, results })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to complete assessment' })
  }
})

// Resume session (get progress)
router.get('/session/resume', psyStudentAuth, async (req, res) => {
  try {
    const session = await pool.query(
      'SELECT * FROM psy_sessions WHERE id=$1', [req.psySession.id]
    )
    const answers = await pool.query(
      'SELECT question_id, response_value FROM psy_answers WHERE session_id=$1', [req.psySession.id]
    )
    res.json({ session: session.rows[0], answers: answers.rows })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

// ── RESULTS & REPORTING (Vipin & Ankur) ──────────────────────────────────────

// Get all students for a test
router.get('/tests/:testId/students', authenticate, psyAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT s.*, se.status, se.completed_at, se.total_time_seconds,
              hc.code as holland_code,
              (SELECT COUNT(*) FROM psy_consistency_flags WHERE student_id=s.id) as flag_count
       FROM psy_students s
       LEFT JOIN psy_sessions se ON se.student_id = s.id
       LEFT JOIN psy_holland_codes hc ON hc.student_id = s.id
       WHERE s.test_id=$1
       ORDER BY se.completed_at DESC NULLS LAST`,
      [req.params.testId]
    )
    res.json({ students: result.rows })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

// Get full student results
router.get('/students/:studentId/results', authenticate, psyAdmin, async (req, res) => {
  try {
    const student   = await pool.query('SELECT * FROM psy_students WHERE id=$1', [req.params.studentId])
    const session   = await pool.query('SELECT * FROM psy_sessions WHERE student_id=$1 ORDER BY created_at DESC LIMIT 1', [req.params.studentId])
    const scores    = await pool.query('SELECT * FROM psy_scores WHERE student_id=$1', [req.params.studentId])
    const holland   = await pool.query('SELECT * FROM psy_holland_codes WHERE student_id=$1', [req.params.studentId])
    const careers   = await pool.query(
      `SELECT cm.*, c.name, c.category, c.description, c.riasec_code,
               c.education_paths, c.top_colleges_india, c.avg_salary_range, c.key_skills
       FROM psy_career_matches cm
       JOIN psy_careers c ON cm.career_id = c.id
       WHERE cm.student_id=$1 ORDER BY cm.rank ASC LIMIT 10`,
      [req.params.studentId]
    )
    const flags     = await pool.query('SELECT * FROM psy_consistency_flags WHERE student_id=$1', [req.params.studentId])

    res.json({
      student:      student.rows[0],
      session:      session.rows[0],
      scores:       scores.rows,
      hollandCode:  holland.rows[0],
      careerMatches: careers.rows,
      flags:        flags.rows
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Server error' })
  }
})

// ── RETAKE AUTHORIZATION ──────────────────────────────────────────────────────

router.post('/retake/authorize', authenticate, psyAdmin, async (req, res) => {
  try {
    const { student_id, reason } = req.body
    
    const session = await pool.query(
      'SELECT id FROM psy_sessions WHERE student_id=$1 ORDER BY created_at DESC LIMIT 1', [student_id]
    )

    // Generate retake code
    const chars  = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    let code = 'RET-'
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)]

    await pool.query(
      `INSERT INTO psy_retake_authorizations 
       (student_id, original_session_id, authorized_by, retake_code, reason, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [student_id, session.rows[0]?.id, req.trainer.id, code, reason,
       new Date(Date.now() + 48 * 60 * 60 * 1000)] // 48 hours
    )

    res.json({ retake_code: code, expires_in: '48 hours' })
  } catch (err) {
    res.status(500).json({ error: 'Failed to authorize retake' })
  }
})

// Retake login
router.post('/retake/login', async (req, res) => {
  try {
    const { participant_id, retake_code } = req.body
    
    const auth = await pool.query(
      'SELECT * FROM psy_retake_authorizations WHERE retake_code=$1 AND is_used=false', [retake_code]
    )
    if (!auth.rows.length) return res.status(401).json({ error: 'Invalid or used retake code' })
    if (new Date(auth.rows[0].expires_at) < new Date()) return res.status(401).json({ error: 'Retake code expired' })

    const student = await pool.query('SELECT * FROM psy_students WHERE participant_id=$1', [participant_id])
    if (!student.rows.length) return res.status(404).json({ error: 'Student not found' })
    if (student.rows[0].id !== auth.rows[0].student_id) return res.status(401).json({ error: 'Invalid credentials' })

    // Mark retake code as used
    await pool.query('UPDATE psy_retake_authorizations SET is_used=true, used_at=NOW() WHERE id=$1', [auth.rows[0].id])

    // Create new session
    const s = student.rows[0]
    const testRes = await pool.query('SELECT * FROM psy_tests WHERE id=$1', [s.test_id])
    const test    = testRes.rows[0]

    const sessionRes = await pool.query(
      `INSERT INTO psy_sessions (student_id, test_id, program_tier, is_retake, retake_code, original_session_id, ip_address)
       VALUES ($1,$2,$3,true,$4,$5,$6) RETURNING *`,
      [s.id, s.test_id, test.program_tier, retake_code, auth.rows[0].original_session_id, req.ip]
    )

    const jwt   = require('jsonwebtoken')
    const token = jwt.sign(
      { psy_student_id: s.id, psy_session_id: sessionRes.rows[0].id, type: 'psy_student' },
      process.env.JWT_SECRET, { expiresIn: '8h' }
    )

    res.json({ token, student: { id: s.id, participant_id: s.participant_id, full_name: s.full_name }, session: sessionRes.rows[0], test })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Retake login failed' })
  }
})

// ── AI REPORT ─────────────────────────────────────────────────────────────────
router.post('/ai-report', authenticate, psyAdmin, async (req, res) => {
  const { prompt } = req.body
  const apiKey     = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return res.status(500).json({ error: 'AI not configured' })

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  const https  = require('https')
  const body   = JSON.stringify({
    model: 'claude-sonnet-4-6', max_tokens: 3000, stream: true,
    messages: [{ role: 'user', content: prompt }]
  })
  const apiReq = https.request({
    hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
  }, (apiRes) => {
    let buffer = ''
    apiRes.on('data', (chunk) => {
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop()
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        try {
          const json = JSON.parse(line.slice(6))
          if (json.type === 'content_block_delta' && json.delta?.text) {
            res.write('data: ' + JSON.stringify({ text: json.delta.text }) + '\n\n')
          }
          if (json.type === 'message_stop') { res.write('data: [DONE]\n\n'); res.end() }
        } catch {}
      }
    })
    apiRes.on('end', () => { try { res.write('data: [DONE]\n\n'); res.end() } catch {} })
  })
  apiReq.on('error', (err) => { try { res.write('data: ' + JSON.stringify({ error: err.message }) + '\n\n'); res.end() } catch {} })
  apiReq.write(body)
  apiReq.end()
})

// ── BATCH ANALYTICS ───────────────────────────────────────────────────────────
router.get('/tests/:testId/analytics', authenticate, psyAdmin, async (req, res) => {
  try {
    const testId = req.params.testId

    const [overview, hollandDist, careerDist, scores] = await Promise.all([
      pool.query(
        `SELECT COUNT(DISTINCT s.id) as total, 
                COUNT(DISTINCT CASE WHEN se.status='completed' THEN se.id END) as completed,
                ROUND(AVG(se.total_time_seconds/60.0),1) as avg_time_minutes
         FROM psy_students s LEFT JOIN psy_sessions se ON se.student_id=s.id WHERE s.test_id=$1`,
        [testId]
      ),
      pool.query(
        `SELECT hc.code, COUNT(*) as count FROM psy_holland_codes hc
         JOIN psy_students s ON hc.student_id=s.id WHERE s.test_id=$1
         GROUP BY hc.code ORDER BY count DESC LIMIT 10`,
        [testId]
      ),
      pool.query(
        `SELECT c.name, c.category, COUNT(*) as matched_count, ROUND(AVG(cm.composite_fit_pct),1) as avg_fit
         FROM psy_career_matches cm JOIN psy_careers c ON cm.career_id=c.id
         JOIN psy_students s ON cm.student_id=s.id WHERE s.test_id=$1 AND cm.rank=1
         GROUP BY c.id, c.name, c.category ORDER BY matched_count DESC LIMIT 10`,
        [testId]
      ),
      pool.query(
        `SELECT ps.dimension, ps.scale, ROUND(AVG(ps.percentage),1) as avg_pct, ROUND(AVG(ps.stanine),1) as avg_stanine
         FROM psy_scores ps JOIN psy_students s ON ps.student_id=s.id WHERE s.test_id=$1
         GROUP BY ps.dimension, ps.scale ORDER BY ps.dimension, ps.scale`,
        [testId]
      ),
    ])

    res.json({
      overview:     overview.rows[0],
      hollandDist:  hollandDist.rows,
      topCareers:   careerDist.rows,
      dimensionAvgs: scores.rows,
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Server error' })
  }
})

// ── CAREERS MANAGEMENT ────────────────────────────────────────────────────────
router.get('/careers', authenticate, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM psy_careers WHERE is_active=true ORDER BY name')
    res.json({ careers: result.rows })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

module.exports = router
