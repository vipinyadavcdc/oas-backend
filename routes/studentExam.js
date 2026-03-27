// CDC OAS — studentExam.js v3.0
// Added: device fingerprint, proxy candidate detection (5-min gap),
//        session lock (one active session per student per exam),
//        suspicious answer speed flagging, heartbeat session update

const express = require('express');
const router  = express.Router();
const pool    = require('../db/pool');
const { calculateResult } = require('./exams');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length-1; i > 0; i--) {
    const j = Math.floor(Math.random()*(i+1));
    [a[i],a[j]]=[a[j],a[i]];
  }
  return a;
}

function interleaveByTopic(questions) {
  const byTopic = {};
  for (const q of questions) {
    if (!byTopic[q.topic]) byTopic[q.topic]=[];
    byTopic[q.topic].push(q);
  }
  const topics = Object.keys(byTopic);
  const result = [];
  let lastTopic = null;
  while (result.length < questions.length) {
    const available = topics.filter(t => byTopic[t].length>0 && t!==lastTopic);
    if (!available.length) {
      const any = topics.find(t => byTopic[t].length>0);
      if (!any) break;
      result.push(byTopic[any].shift()); lastTopic=any;
    } else {
      const pick = available[Math.floor(Math.random()*available.length)];
      result.push(byTopic[pick].shift()); lastTopic=pick;
    }
  }
  return result;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function generateParticipantId() {
  // 10-digit unique number e.g. 4724381065
  return Math.floor(1000000000 + Math.random() * 9000000000).toString()
}

// ─── POST /api/exam/verify ────────────────────────────────────────────────────

router.post('/verify', async (req, res) => {
  const { room_code } = req.body;
  if (!room_code) return res.status(400).json({ error: 'Room code required' });
  try {
    const code = room_code.trim().toUpperCase();

    // Check normal room code first
    let result = await pool.query(
      `SELECT id,title,description,exam_type,university,department,section_filter,
              duration_minutes,start_time,end_time,total_questions,status,
              aptitude_time_minutes,verbal_time_minutes,device_allowed,
              marks_per_question,negative_marking,negative_marks,master_room_code
       FROM exams WHERE room_code=$1`,
      [code]
    );

    let isMasterCode = false;

    // If not found as normal code, check master code (5-digit numeric)
    if (!result.rows.length) {
      result = await pool.query(
        `SELECT id,title,description,exam_type,university,department,section_filter,
                duration_minutes,start_time,end_time,total_questions,status,
                aptitude_time_minutes,verbal_time_minutes,device_allowed,
                marks_per_question,negative_marking,negative_marks,master_room_code
         FROM exams WHERE master_room_code=$1`,
        [code]
      );
      if (result.rows.length) isMasterCode = true;
    }

    if (!result.rows.length) return res.status(404).json({ error: 'Invalid room code' });
    const exam = result.rows[0];

    if (isMasterCode) {
      // Master code — only works for active/live/published exams
      if (['draft','ended'].includes(exam.status)) {
        return res.status(403).json({ error: 'No active exam found for this master code' });
      }
      return res.json({ exam, is_master_code: true });
    }

    // Normal code checks
    if (exam.status==='draft')  return res.status(403).json({ error: 'Exam not published yet' });
    if (exam.status==='ended')  return res.status(403).json({ error: 'Exam has ended' });
    const now = new Date();
    if (exam.start_time && new Date(exam.start_time)>now) {
      const st = new Date(exam.start_time);
      const timeStr = st.toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit' });
      const dateStr = st.toLocaleDateString('en-IN',  { day:'2-digit', month:'short', year:'numeric' });
      return res.status(403).json({ error: `Exam window opens at ${timeStr} on ${dateStr}. Please wait.` });
    }
    if (exam.end_time && new Date(exam.end_time)<now) {
      return res.status(403).json({ error: 'Exam window has passed' });
    }
    res.json({ exam, is_master_code: false });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── POST /api/exam/start ─────────────────────────────────────────────────────

router.post('/start', async (req, res) => {
  const {
    exam_id, room_code, name, roll_number, mobile, email,
    university, department, section, geolocation, device_fingerprint,
    is_master_code, participant_id_input
  } = req.body;

  if (!exam_id||!name||!roll_number||!mobile||!email||!university||!department||!section)
    return res.status(400).json({ error: 'All student details required' });

  const clientIP = req.ip || req.connection?.remoteAddress || '';
  const RESUME_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

  // ══ MASTER CODE RESUME PATH ════════════════════════════════════════════════
  if (is_master_code) {
    if (!participant_id_input) {
      return res.status(400).json({ error: 'Participant ID is required to resume' });
    }
    const client2 = await pool.connect();
    try {
      const sessRes = await client2.query(
        `SELECT ss.*, e.aptitude_time_minutes, e.verbal_time_minutes, e.title as exam_title,
                e.duration_minutes as exam_duration, e.marks_per_question, e.negative_marking,
                e.negative_marks, e.total_questions as exam_total_q
         FROM student_sessions ss
         JOIN exams e ON ss.exam_id = e.id
         WHERE ss.exam_id=$1 AND UPPER(ss.roll_number)=$2`,
        [exam_id, roll_number.trim().toUpperCase()]
      );

      if (!sessRes.rows.length) {
        return res.status(404).json({
          error: 'No exam session found for this roll number. Use the normal room code to start your exam.'
        });
      }

      const sess = sessRes.rows[0];

      if (sess.participant_id !== participant_id_input.trim()) {
        return res.status(403).json({
          error: 'Participant ID does not match. Please check the ID you wrote on your paper.'
        });
      }

      if (['submitted','auto_submitted'].includes(sess.status)) {
        return res.status(400).json({
          error: 'Your exam has already been submitted. Please contact your trainer.'
        });
      }

      // Heartbeat gap for flagging
      const hbRes   = await client2.query(
        'SELECT pinged_at FROM heartbeats WHERE session_id=$1 ORDER BY pinged_at DESC LIMIT 1',
        [sess.id]
      );
      const lastHb  = hbRes.rows[0]?.pinged_at;
      const gapSecs = lastHb ? Math.floor((Date.now() - new Date(lastHb).getTime()) / 1000) : null;
      const isSuspicious = gapSecs !== null && gapSecs < 120;
      const flagReason   = isSuspicious
        ? `Resume gap only ${gapSecs}s — possible intentional disconnect` : null;

      // Log resume
      await client2.query(
        `INSERT INTO resume_logs
           (session_id,exam_id,roll_number,participant_id,heartbeat_gap_seconds,is_flagged,flag_reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [sess.id, exam_id, roll_number.trim().toUpperCase(),
         participant_id_input.trim(), gapSecs, isSuspicious, flagReason]
      );

      // Update resume count, flag if suspicious, violations reset to 1
      await client2.query(
        `UPDATE student_sessions
         SET resume_count    = resume_count + 1,
             last_resumed_at = NOW(),
             is_flagged      = CASE WHEN $1 THEN true ELSE is_flagged END
         WHERE id = $2`,
        [isSuspicious, sess.id]
      );

      if (sess.status !== 'active') {
        await client2.query("UPDATE student_sessions SET status='active' WHERE id=$1", [sess.id]);
      }

      const answers = await client2.query(
        'SELECT * FROM student_answers WHERE session_id=$1', [sess.id]
      );
      const qRes = await client2.query(
        `SELECT q.id,q.section,q.topic,q.question_text,
                q.option_a,q.option_b,q.option_c,q.option_d,q.image_url
         FROM exam_questions eq JOIN questions q ON eq.question_id=q.id
         WHERE eq.exam_id=$1 ORDER BY eq.sequence_order`,
        [exam_id]
      );

      return res.json({
        session:        sess,
        answers:        answers.rows,
        resumed:        true,
        resume_flagged: isSuspicious,
        questions:      qRes.rows,
        violation_reset_to: 1,
        exam: {
          id:                    exam_id,
          title:                 sess.exam_title,
          duration_minutes:      sess.exam_duration,
          end_time:              null,
          aptitude_time_minutes: sess.aptitude_time_minutes || 0,
          verbal_time_minutes:   sess.verbal_time_minutes   || 0,
          device_allowed:        'both',
          marks_per_question:    sess.marks_per_question,
          negative_marking:      sess.negative_marking,
          negative_marks:        sess.negative_marks,
          total_questions:       sess.exam_total_q
        }
      });
    } catch (err) {
      console.error('RESUME ERR:', err);
      return res.status(500).json({ error: 'Server error during resume' });
    } finally {
      client2.release();
    }
  }

  // ══ NORMAL START PATH ══════════════════════════════════════════════════════
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const examRes = await client.query(
      'SELECT * FROM exams WHERE id=$1 AND room_code=$2',
      [exam_id, room_code?.toUpperCase()]
    );
    if (!examRes.rows.length) return res.status(404).json({ error: 'Invalid exam or room code' });
    const exam = examRes.rows[0];
    if (['draft','ended'].includes(exam.status)) return res.status(403).json({ error: 'Exam not available' });

    // Check existing session
    const dup = await client.query(
      'SELECT id, status, started_at FROM student_sessions WHERE exam_id=$1 AND roll_number=$2',
      [exam_id, roll_number.trim().toUpperCase()]
    );

    if (dup.rows.length) {
      const existing  = dup.rows[0];
      const elapsed   = Date.now() - new Date(existing.started_at).getTime();

      // Already submitted — always block
      if (['submitted','auto_submitted'].includes(existing.status)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'You have already submitted this exam.' });
      }

      // Within 15 minutes — silent resume (refresh / accidental close)
      if (elapsed < RESUME_WINDOW_MS) {
        const sess    = await client.query('SELECT * FROM student_sessions WHERE id=$1', [existing.id]);
        const answers = await client.query('SELECT * FROM student_answers WHERE session_id=$1', [existing.id]);
        const re      = (await client.query('SELECT * FROM exams WHERE id=$1', [exam_id])).rows[0];
        const qRes    = await client.query(
          `SELECT q.id,q.section,q.topic,q.question_text,
                  q.option_a,q.option_b,q.option_c,q.option_d,q.image_url
           FROM exam_questions eq JOIN questions q ON eq.question_id=q.id
           WHERE eq.exam_id=$1 ORDER BY eq.sequence_order`,
          [exam_id]
        );
        await client.query('COMMIT');
        return res.json({
          session:   sess.rows[0],
          answers:   answers.rows,
          resumed:   true,
          questions: qRes.rows,
          exam: {
            id: re.id, title: re.title, duration_minutes: re.duration_minutes,
            end_time: re.end_time, aptitude_time_minutes: re.aptitude_time_minutes || 0,
            verbal_time_minutes: re.verbal_time_minutes || 0, device_allowed: re.device_allowed || 'both',
            marks_per_question: re.marks_per_question, negative_marking: re.negative_marking,
            negative_marks: re.negative_marks, total_questions: re.total_questions
          }
        });
      }

      // After 15 minutes — must use master code
      await client.query('ROLLBACK');
      return res.status(403).json({
        error: 'Your session is already active. To resume, use the Master Code given by CDC team member.',
        needs_master_code: true
      });
    }

    // ── PROXY DETECTION ─────────────────────────────────────────────────────
    if (device_fingerprint) {
      const PROXY_GAP_SECONDS = 300;
      const proxyCheck = await client.query(
        `SELECT ss.id, ss.name, ss.roll_number, ss.submitted_at, ss.started_at, ss.ip_address
         FROM student_sessions ss
         WHERE ss.exam_id=$1 AND ss.device_fingerprint=$2 AND ss.roll_number!=$3
           AND ss.status IN ('submitted','auto_submitted','active')
         ORDER BY COALESCE(ss.submitted_at, ss.started_at) DESC LIMIT 1`,
        [exam_id, device_fingerprint, roll_number.trim().toUpperCase()]
      );
      if (proxyCheck.rows.length) {
        const prev       = proxyCheck.rows[0];
        const prevTime   = prev.submitted_at || prev.started_at;
        const gapSeconds = Math.floor((new Date() - new Date(prevTime)) / 1000);
        if (gapSeconds < PROXY_GAP_SECONDS) {
          try {
            await client.query(
              `INSERT INTO proxy_alerts
                 (exam_id,session_id_1,device_fingerprint,ip_address_1,ip_address_2,
                  submitted_at_1,started_at_2,gap_seconds,alert_type)
               VALUES ($1,$2,$3,$4,$5,$6,NOW(),$7,'same_device_gap')`,
              [exam_id, prev.id, device_fingerprint, prev.ip_address, clientIP, prev.submitted_at, gapSeconds]
            );
          } catch {}
          await client.query('ROLLBACK');
          return res.status(403).json({
            error: `Security check failed. This device was used by another student recently. Please contact your trainer.`
          });
        }
      }
    }

    // ── LOAD QUESTIONS ───────────────────────────────────────────────────────
    const qRes = await client.query(
      `SELECT q.id,q.section,q.topic,q.question_text,
              q.option_a,q.option_b,q.option_c,q.option_d,q.image_url
       FROM exam_questions eq JOIN questions q ON eq.question_id=q.id
       WHERE eq.exam_id=$1 ORDER BY eq.sequence_order`,
      [exam_id]
    );
    let questions = qRes.rows;
    if (exam.randomize_questions) questions = interleaveByTopic(shuffle(questions));

    const question_order = questions.map(q => q.id);
    const option_orders  = {};
    const shuffledQuestions = questions.map(q => {
      const opts         = ['A','B','C','D'];
      const shuffledOpts = exam.randomize_options ? shuffle(opts) : opts;
      option_orders[q.id] = shuffledOpts;
      return {
        ...q,
        display_options: {
          A: q['option_'+shuffledOpts[0].toLowerCase()],
          B: q['option_'+shuffledOpts[1].toLowerCase()],
          C: q['option_'+shuffledOpts[2].toLowerCase()],
          D: q['option_'+shuffledOpts[3].toLowerCase()]
        },
        option_map: shuffledOpts
      };
    });

    // ── GENERATE UNIQUE PARTICIPANT ID ───────────────────────────────────────
    let participantId = null;
    for (let attempt = 0; attempt < 10; attempt++) {
      const tryId  = generateParticipantId();
      const exists = await client.query(
        'SELECT id FROM student_sessions WHERE participant_id=$1', [tryId]
      );
      if (!exists.rows.length) { participantId = tryId; break; }
    }
    if (!participantId) participantId = generateParticipantId();

    // ── CREATE SESSION ───────────────────────────────────────────────────────
    const sessRes = await client.query(
      `INSERT INTO student_sessions
         (exam_id,name,roll_number,mobile,email,university,department,section,
          ip_address,geolocation,user_agent,question_order,option_orders,
          device_fingerprint,last_active_at,participant_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW(),$15)
       RETURNING *`,
      [
        exam_id, name.trim(), roll_number.trim().toUpperCase(),
        mobile.trim(), email.trim().toLowerCase(),
        university, department.trim(), section.trim(),
        clientIP,
        geolocation ? JSON.stringify(geolocation) : null,
        req.headers['user-agent'],
        JSON.stringify(question_order),
        JSON.stringify(option_orders),
        device_fingerprint || null,
        participantId
      ]
    );

    if (exam.status==='published') {
      await client.query("UPDATE exams SET status='live' WHERE id=$1", [exam_id]);
    }
    await client.query('COMMIT');

    const aptitudeQs = shuffledQuestions.filter(q => q.section === 'aptitude_reasoning');
    const verbalQs   = shuffledQuestions.filter(q => q.section === 'verbal');

    res.json({
      session:            sessRes.rows[0],
      questions:          shuffledQuestions,
      aptitude_questions: aptitudeQs,
      verbal_questions:   verbalQs,
      has_both_sections:  aptitudeQs.length > 0 && verbalQs.length > 0,
      exam: {
        id:                    exam.id,
        title:                 exam.title,
        duration_minutes:      exam.duration_minutes,
        end_time:              exam.end_time,
        aptitude_time_minutes: exam.aptitude_time_minutes || 0,
        verbal_time_minutes:   exam.verbal_time_minutes   || 0,
        device_allowed:        exam.device_allowed || 'both',
        marks_per_question:    exam.marks_per_question,
        negative_marking:      exam.negative_marking,
        negative_marks:        exam.negative_marks,
        total_questions:       exam.total_questions
      }
    });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('START ERR:', err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// ─── POST /api/exam/save-answer ───────────────────────────────────────────────

router.post('/save-answer', async (req, res) => {
  const { session_token, question_id, selected_option, is_bookmarked, time_spent_seconds } = req.body;
  if (!session_token||!question_id) return res.status(400).json({ error: 'session_token and question_id required' });
  try {
    const sess = await pool.query(
      "SELECT id,option_orders FROM student_sessions WHERE session_token=$1 AND status='active'",
      [session_token]
    );
    if (!sess.rows.length) return res.status(403).json({ error: 'Invalid or expired session' });

    const { id: session_id, option_orders } = sess.rows[0];

    // Map display option back to real option
    let mapped_option = selected_option;
    if (selected_option && option_orders && option_orders[question_id]) {
      const displayIndex = ['A','B','C','D'].indexOf(selected_option);
      if (displayIndex !== -1) mapped_option = option_orders[question_id][displayIndex];
    }

    // Flag suspiciously fast answers (< 3 seconds) — optional, doesn't block
    const flagFast = time_spent_seconds > 0 && time_spent_seconds < 3;

    await pool.query(
      `INSERT INTO student_answers (session_id,question_id,selected_option,is_bookmarked,time_spent_seconds,flagged_fast)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (session_id,question_id)
       DO UPDATE SET selected_option=$3, is_bookmarked=$4, time_spent_seconds=$5, flagged_fast=$6, updated_at=NOW()`,
      [session_id, question_id, mapped_option||null, is_bookmarked||false, time_spent_seconds||0, flagFast]
    );

    // Update last_active_at (heartbeat-like, lightweight)
    await pool.query('UPDATE student_sessions SET last_active_at=NOW() WHERE id=$1', [session_id]);

    res.json({ saved: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── POST /api/exam/heartbeat ─────────────────────────────────────────────────

router.post('/heartbeat', async (req, res) => {
  const { session_token } = req.body;
  try {
    const sess = await pool.query(
      "SELECT id FROM student_sessions WHERE session_token=$1 AND status='active'",
      [session_token]
    );
    if (!sess.rows.length) return res.status(404).json({ alive: false });

    const session_id = sess.rows[0].id;

    // Update last_active_at
    await pool.query('UPDATE student_sessions SET last_active_at=NOW() WHERE id=$1', [session_id]);
    await pool.query('INSERT INTO heartbeats (session_id) VALUES ($1)', [session_id]);

    // Check for time extensions
    const ext = await pool.query(
      "SELECT details FROM violations WHERE session_id=$1 AND violation_type='time_extended' ORDER BY occurred_at DESC LIMIT 1",
      [session_id]
    );
    let extraMinutes = 0;
    if (ext.rows.length) {
      const details = ext.rows[0].details;
      extraMinutes = details?.extra_minutes || details?.minutes || 0;
      await pool.query("DELETE FROM violations WHERE session_id=$1 AND violation_type='time_extended'", [session_id]);
    }

    res.json({ alive: true, extraMinutes });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── POST /api/exam/violation ─────────────────────────────────────────────────

router.post('/violation', async (req, res) => {
  const { session_token, violation_type, details } = req.body;
  if (!session_token||!violation_type) return res.status(400).json({ error: 'Required fields missing' });
  try {
    const sess = await pool.query(
      'SELECT id FROM student_sessions WHERE session_token=$1',
      [session_token]
    );
    if (!sess.rows.length) return res.status(404).json({ error: 'Session not found' });

    const session_id = sess.rows[0].id;
    await pool.query(
      'INSERT INTO violations (session_id,violation_type,details) VALUES ($1,$2,$3)',
      [session_id, violation_type, JSON.stringify(details||{})]
    );

    // Auto-flag logic
    const tabSwitches  = await pool.query("SELECT COUNT(*) FROM violations WHERE session_id=$1 AND violation_type='tab_switch'",   [session_id]);
    const appSwitches  = await pool.query("SELECT COUNT(*) FROM violations WHERE session_id=$1 AND violation_type='app_switch'",   [session_id]);
    const splitScreen  = await pool.query("SELECT COUNT(*) FROM violations WHERE session_id=$1 AND violation_type IN ('split_screen','split_screen_or_ai','screen_mirror_or_split')", [session_id]);
    const devTools     = await pool.query("SELECT COUNT(*) FROM violations WHERE session_id=$1 AND violation_type='devtools_open'", [session_id]);

    const tabs   = parseInt(tabSwitches.rows[0].count)  + parseInt(appSwitches.rows[0].count);
    const splits = parseInt(splitScreen.rows[0].count);
    const dev    = parseInt(devTools.rows[0].count);

    if (tabs >= 3 || splits >= 2 || dev >= 2) {
      await pool.query('UPDATE student_sessions SET is_flagged=true WHERE id=$1', [session_id]);
    }

    res.json({ logged: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── POST /api/exam/submit ────────────────────────────────────────────────────

router.post('/submit', async (req, res) => {
  const { session_token } = req.body;
  if (!session_token) return res.status(400).json({ error: 'session_token required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const sess = await client.query(
      "SELECT * FROM student_sessions WHERE session_token=$1 AND status='active'",
      [session_token]
    );
    if (!sess.rows.length) return res.status(400).json({ error: 'Session not found or already submitted' });
    const session   = sess.rows[0];
    const time_taken = Math.floor((new Date() - new Date(session.started_at)) / 1000);
    await client.query(
      "UPDATE student_sessions SET status='submitted', submitted_at=NOW(), time_taken_seconds=$1 WHERE id=$2",
      [time_taken, session.id]
    );
    await calculateResult(client, session.id, session.exam_id);
    await client.query('COMMIT');
    res.json({ message: 'Exam submitted successfully', time_taken_seconds: time_taken });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// ─── POST /api/exam/submit-section ───────────────────────────────────────────

router.post('/submit-section', async (req, res) => {
  const { session_token, section } = req.body;
  if (!session_token || !section) return res.status(400).json({ error: 'session_token and section required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const sess = await client.query(
      `SELECT ss.*, e.aptitude_time_minutes, e.verbal_time_minutes
       FROM student_sessions ss JOIN exams e ON ss.exam_id=e.id
       WHERE ss.session_token=$1 AND ss.status='active'`,
      [session_token]
    );
    if (!sess.rows.length) return res.status(403).json({ error: 'Invalid or expired session' });
    const s = sess.rows[0];
    const now = new Date();
    if (section === 'aptitude_reasoning') {
      const started  = s.aptitude_started_at ? new Date(s.aptitude_started_at) : new Date(s.started_at);
      const timeUsed = Math.floor((now - started) / 1000);
      await client.query(
        'UPDATE student_sessions SET aptitude_submitted_at=NOW(), aptitude_time_used=$1, current_section=$2 WHERE id=$3',
        [timeUsed, 'verbal', s.id]
      );
    } else {
      const started  = s.verbal_started_at ? new Date(s.verbal_started_at) : new Date(s.started_at);
      const timeUsed = Math.floor((now - started) / 1000);
      await client.query(
        'UPDATE student_sessions SET verbal_submitted_at=NOW(), verbal_time_used=$1, current_section=$2 WHERE id=$3',
        [timeUsed, 'aptitude_reasoning', s.id]
      );
    }
    await client.query('COMMIT');
    res.json({ success: true, next_section: section === 'aptitude_reasoning' ? 'verbal' : 'aptitude_reasoning' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// ─── POST /api/exam/start-section ────────────────────────────────────────────

router.post('/start-section', async (req, res) => {
  const { session_token, section } = req.body;
  if (!session_token || !section) return res.status(400).json({ error: 'Required fields missing' });
  try {
    const sess = await pool.query(
      "SELECT id FROM student_sessions WHERE session_token=$1 AND status='active'",
      [session_token]
    );
    if (!sess.rows.length) return res.status(403).json({ error: 'Invalid session' });
    const col = section === 'aptitude_reasoning' ? 'aptitude_started_at' : 'verbal_started_at';
    await pool.query(
      `UPDATE student_sessions SET ${col}=NOW(), current_section=$1, last_active_at=NOW() WHERE id=$2`,
      [section, sess.rows[0].id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── GET /api/exam/proxy-alerts (admin) ──────────────────────────────────────

router.get('/proxy-alerts', async (req, res) => {
  // Requires trainer auth — attach auth middleware in server.js if needed
  try {
    const alerts = await pool.query(
      `SELECT pa.*,
              ss1.name as name_1, ss1.roll_number as roll_1,
              ss2.name as name_2, ss2.roll_number as roll_2,
              e.title as exam_title
       FROM proxy_alerts pa
       LEFT JOIN student_sessions ss1 ON pa.session_id_1 = ss1.id
       LEFT JOIN student_sessions ss2 ON pa.session_id_2 = ss2.id
       JOIN exams e ON pa.exam_id = e.id
       WHERE pa.is_reviewed = false
       ORDER BY pa.created_at DESC
       LIMIT 100`
    );
    res.json({ alerts: alerts.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Auto-submit cron (every 60s) ────────────────────────────────────────────

setInterval(async () => {
  try {
    const expired = await pool.query(
      `SELECT ss.id, ss.exam_id FROM student_sessions ss
       JOIN exams e ON ss.exam_id = e.id
       WHERE ss.status = 'active'
         AND e.end_time IS NOT NULL
         AND e.end_time < NOW()`
    );
    for (const s of expired.rows) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const time_taken = await pool.query(
          'SELECT EXTRACT(EPOCH FROM (NOW() - started_at))::int as secs FROM student_sessions WHERE id=$1',
          [s.id]
        );
        await client.query(
          "UPDATE student_sessions SET status='auto_submitted', submitted_at=NOW(), time_taken_seconds=$1 WHERE id=$2",
          [time_taken.rows[0].secs, s.id]
        );
        const { calculateResult } = require('./exams');
        await calculateResult(client, s.id, s.exam_id);
        await client.query('COMMIT');
        console.log('Auto-submitted session ' + s.id + ' (end_time passed)');
      } catch (e) {
        await client.query('ROLLBACK');
        console.error('Auto-submit error:', e.message);
      } finally { client.release(); }
    }
  } catch (e) {
    console.error('Auto-submit cron error:', e.message);
  }
}, 60000);

module.exports = router;
