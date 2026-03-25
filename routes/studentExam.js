const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { calculateResult } = require('./exams');

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length-1; i > 0; i--) { const j = Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; }
  return a;
}

function interleaveByTopic(questions) {
  const byTopic = {};
  for (const q of questions) { if (!byTopic[q.topic]) byTopic[q.topic]=[]; byTopic[q.topic].push(q); }
  const topics = Object.keys(byTopic);
  const result = []; let lastTopic = null;
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

// POST /api/exam/verify
router.post('/verify', async (req, res) => {
  const { room_code } = req.body;
  if (!room_code) return res.status(400).json({ error: 'Room code required' });
  try {
    const result = await pool.query(
      'SELECT id,title,description,exam_type,university,department,section_filter,duration_minutes,start_time,end_time,total_questions,status,aptitude_time_minutes,verbal_time_minutes,device_allowed,marks_per_question,negative_marking,negative_marks FROM exams WHERE room_code=$1',
      [room_code.toUpperCase().trim()]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Invalid room code' });
    const exam = result.rows[0];
    if (exam.status==='draft') return res.status(403).json({ error: 'Exam not published yet' });
    if (exam.status==='ended') return res.status(403).json({ error: 'Exam has ended' });
    const now = new Date();
    if (exam.start_time && new Date(exam.start_time)>now) {
      const st = new Date(exam.start_time);
      const timeStr = st.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
      const dateStr = st.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
      return res.status(403).json({ error: 'Exam window opens at ' + timeStr + ' on ' + dateStr + '. Please wait and try again.' });
    }
    if (exam.end_time && new Date(exam.end_time)<now) return res.status(403).json({ error: 'Exam window has passed' });
    res.json({ exam });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// POST /api/exam/start
router.post('/start', async (req, res) => {
  const { exam_id, room_code, name, roll_number, mobile, email, university, department, section, geolocation } = req.body;
  if (!exam_id||!name||!roll_number||!mobile||!email||!university||!department||!section)
    return res.status(400).json({ error: 'All student details required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const examRes = await client.query('SELECT * FROM exams WHERE id=$1 AND room_code=$2', [exam_id, room_code?.toUpperCase()]);
    if (!examRes.rows.length) return res.status(404).json({ error: 'Invalid exam or room code' });
    const exam = examRes.rows[0];
    if (['draft','ended'].includes(exam.status)) return res.status(403).json({ error: 'Exam not available' });
    const dup = await client.query('SELECT id,status FROM student_sessions WHERE exam_id=$1 AND roll_number=$2', [exam_id, roll_number.trim().toUpperCase()]);
    if (dup.rows.length) {
      const existing = dup.rows[0];
      if (existing.status !== 'active') return res.status(400).json({ error: 'You have already submitted this exam' });
      const sess = await client.query('SELECT * FROM student_sessions WHERE id=$1', [existing.id]);
      const answers = await client.query('SELECT * FROM student_answers WHERE session_id=$1', [existing.id]);
      await client.query('COMMIT');
      return res.json({ session: sess.rows[0], answers: answers.rows, resumed: true });
    }
    const qRes = await client.query(
      'SELECT q.id,q.section,q.topic,q.question_text,q.option_a,q.option_b,q.option_c,q.option_d,q.image_url FROM exam_questions eq JOIN questions q ON eq.question_id=q.id WHERE eq.exam_id=$1 ORDER BY eq.sequence_order',
      [exam_id]
    );
    let questions = qRes.rows;
    if (exam.randomize_questions) questions = interleaveByTopic(shuffle(questions));
    const question_order = questions.map(q => q.id);
    const option_orders = {};
    const shuffledQuestions = questions.map(q => {
      const opts = ['A','B','C','D'];
      const shuffledOpts = exam.randomize_options ? shuffle(opts) : opts;
      option_orders[q.id] = shuffledOpts;
      return { ...q, display_options: { A: q['option_'+shuffledOpts[0].toLowerCase()], B: q['option_'+shuffledOpts[1].toLowerCase()], C: q['option_'+shuffledOpts[2].toLowerCase()], D: q['option_'+shuffledOpts[3].toLowerCase()] }, option_map: shuffledOpts };
    });
    const sessRes = await client.query(
      'INSERT INTO student_sessions (exam_id,name,roll_number,mobile,email,university,department,section,ip_address,geolocation,user_agent,question_order,option_orders) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *',
      [exam_id, name.trim(), roll_number.trim().toUpperCase(), mobile.trim(), email.trim().toLowerCase(), university, department.trim(), section.trim(), req.ip, geolocation?JSON.stringify(geolocation):null, req.headers['user-agent'], JSON.stringify(question_order), JSON.stringify(option_orders)]
    );
    if (exam.status==='published') await client.query("UPDATE exams SET status='live' WHERE id=$1", [exam_id]);
    await client.query('COMMIT');
    // Split questions by section
      const aptitudeQs = shuffledQuestions.filter(q => q.section === 'aptitude_reasoning')
      const verbalQs = shuffledQuestions.filter(q => q.section === 'verbal')
      const hasBothSections = aptitudeQs.length > 0 && verbalQs.length > 0

      res.json({
        session: sessRes.rows[0],
        questions: shuffledQuestions,
        aptitude_questions: aptitudeQs,
        verbal_questions: verbalQs,
        has_both_sections: hasBothSections,
        exam: {
          id: exam.id, title: exam.title,
          duration_minutes: exam.duration_minutes,
          end_time: exam.end_time,
          aptitude_time_minutes: exam.aptitude_time_minutes || 0,
          verbal_time_minutes: exam.verbal_time_minutes || 0,
          device_allowed: exam.device_allowed || 'both',
          marks_per_question: exam.marks_per_question,
          negative_marking: exam.negative_marking,
          negative_marks: exam.negative_marks,
          total_questions: exam.total_questions
        }
      });
  } catch (err) { await client.query('ROLLBACK'); console.error(err); res.status(500).json({ error: 'Server error' }); }
  finally { client.release(); }
});

// POST /api/exam/save-answer — now accepts time_spent_seconds
router.post('/save-answer', async (req, res) => {
  const { session_token, question_id, selected_option, is_bookmarked, time_spent_seconds } = req.body;
  if (!session_token||!question_id) return res.status(400).json({ error: 'session_token and question_id required' });
  try {
    const sess = await pool.query("SELECT id FROM student_sessions WHERE session_token=$1 AND status='active'", [session_token]);
    if (!sess.rows.length) return res.status(403).json({ error: 'Invalid or expired session' });
    const session_id = sess.rows[0].id;
    const sessionData = await pool.query('SELECT option_orders FROM student_sessions WHERE id=$1', [session_id]);
    const option_orders = sessionData.rows[0].option_orders;
    let mapped_option = selected_option;
    if (selected_option && option_orders && option_orders[question_id]) {
      const displayIndex = ['A','B','C','D'].indexOf(selected_option);
      if (displayIndex !== -1) mapped_option = option_orders[question_id][displayIndex];
    }
    await pool.query(
      'INSERT INTO student_answers (session_id,question_id,selected_option,is_bookmarked,time_spent_seconds) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (session_id,question_id) DO UPDATE SET selected_option=$3, is_bookmarked=$4, time_spent_seconds=$5, updated_at=NOW()',
      [session_id, question_id, mapped_option||null, is_bookmarked||false, time_spent_seconds||0]
    );
    res.json({ saved: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// POST /api/exam/heartbeat
router.post('/heartbeat', async (req, res) => {
  const { session_token } = req.body;
  try {
    const sess = await pool.query("SELECT id FROM student_sessions WHERE session_token=$1 AND status='active'", [session_token]);
    if (!sess.rows.length) return res.status(404).json({ alive: false });
    await pool.query('INSERT INTO heartbeats (session_id) VALUES ($1)', [sess.rows[0].id]);
    res.json({ alive: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// POST /api/exam/violation — includes split_screen type
router.post('/violation', async (req, res) => {
  const { session_token, violation_type, details } = req.body;
  if (!session_token||!violation_type) return res.status(400).json({ error: 'Required fields missing' });
  try {
    const sess = await pool.query('SELECT id FROM student_sessions WHERE session_token=$1', [session_token]);
    if (!sess.rows.length) return res.status(404).json({ error: 'Session not found' });
    const session_id = sess.rows[0].id;
    await pool.query('INSERT INTO violations (session_id,violation_type,details) VALUES ($1,$2,$3)', [session_id, violation_type, JSON.stringify(details||{})]);

    // Flag if tab_switch >= 3 OR split_screen >= 2
    const tabSwitches = await pool.query("SELECT COUNT(*) FROM violations WHERE session_id=$1 AND violation_type='tab_switch'", [session_id]);
    const splitScreen = await pool.query("SELECT COUNT(*) FROM violations WHERE session_id=$1 AND violation_type='split_screen'", [session_id]);
    if (parseInt(tabSwitches.rows[0].count)>=3 || parseInt(splitScreen.rows[0].count)>=2) {
      await pool.query('UPDATE student_sessions SET is_flagged=true WHERE id=$1', [session_id]);
    }
    res.json({ logged: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// POST /api/exam/submit
router.post('/submit', async (req, res) => {
  const { session_token } = req.body;
  if (!session_token) return res.status(400).json({ error: 'session_token required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const sess = await client.query("SELECT * FROM student_sessions WHERE session_token=$1 AND status='active'", [session_token]);
    if (!sess.rows.length) return res.status(400).json({ error: 'Session not found or already submitted' });
    const session = sess.rows[0];
    const time_taken = Math.floor((new Date() - new Date(session.started_at)) / 1000);
    await client.query("UPDATE student_sessions SET status='submitted', submitted_at=NOW(), time_taken_seconds=$1 WHERE id=$2", [time_taken, session.id]);
    await calculateResult(client, session.id, session.exam_id);
    await client.query('COMMIT');
    res.json({ message: 'Exam submitted successfully', time_taken_seconds: time_taken });
  } catch (err) { await client.query('ROLLBACK'); console.error(err); res.status(500).json({ error: 'Server error' }); }
  finally { client.release(); }
});

// POST /api/exam/submit-section — submit current section, move to next
router.post('/submit-section', async (req, res) => {
  const { session_token, section } = req.body
  if (!session_token || !section) return res.status(400).json({ error: 'session_token and section required' })
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const sess = await client.query("SELECT * FROM student_sessions WHERE session_token=$1 AND status='active'", [session_token])
    if (!sess.rows.length) return res.status(403).json({ error: 'Invalid or expired session' })
    const session = sess.rows[0]
    const now = new Date()

    if (section === 'aptitude_reasoning') {
      const timeUsed = session.aptitude_started_at ?
        Math.floor((now - new Date(session.aptitude_started_at)) / 1000) : 0
      await client.query(
        'UPDATE student_sessions SET aptitude_submitted_at=NOW(), aptitude_time_used=$1, current_section=$2 WHERE id=$3',
        [timeUsed, 'verbal', session.id]
      )
    } else {
      const timeUsed = session.verbal_started_at ?
        Math.floor((now - new Date(session.verbal_started_at)) / 1000) : 0
      await client.query(
        'UPDATE student_sessions SET verbal_submitted_at=NOW(), verbal_time_used=$1, current_section=$2 WHERE id=$3',
        [timeUsed, 'aptitude_reasoning', session.id]
      )
    }

    await client.query('COMMIT')
    res.json({ success: true, next_section: section === 'aptitude_reasoning' ? 'verbal' : 'aptitude_reasoning' })
  } catch (err) {
    await client.query('ROLLBACK')
    console.error(err)
    res.status(500).json({ error: 'Server error' })
  } finally { client.release() }
})

// POST /api/exam/start-section — record when student starts a section
router.post('/start-section', async (req, res) => {
  const { session_token, section } = req.body
  if (!session_token || !section) return res.status(400).json({ error: 'Required fields missing' })
  try {
    const sess = await pool.query("SELECT id FROM student_sessions WHERE session_token=$1 AND status='active'", [session_token])
    if (!sess.rows.length) return res.status(403).json({ error: 'Invalid session' })
    const col = section === 'aptitude_reasoning' ? 'aptitude_started_at' : 'verbal_started_at'
    await pool.query(`UPDATE student_sessions SET ${col}=NOW(), current_section=$1 WHERE id=$2`, [section, sess.rows[0].id])
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

// POST /api/exam/submit-section — submit current section and move to next
router.post('/submit-section', async (req, res) => {
  const { session_token, section } = req.body;
  if (!session_token || !section) return res.status(400).json({ error: 'session_token and section required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const sess = await client.query(
      "SELECT ss.*, e.aptitude_time_minutes, e.verbal_time_minutes FROM student_sessions ss JOIN exams e ON ss.exam_id=e.id WHERE ss.session_token=$1 AND ss.status='active'",
      [session_token]
    );
    if (!sess.rows.length) return res.status(403).json({ error: 'Invalid or expired session' });
    const s = sess.rows[0];
    const now = new Date();

    if (section === 'aptitude_reasoning') {
      const started = s.aptitude_started_at ? new Date(s.aptitude_started_at) : new Date(s.started_at);
      const timeUsed = Math.floor((now - started) / 1000);
      await client.query(
        'UPDATE student_sessions SET aptitude_submitted_at=NOW(), aptitude_time_used=$1, current_section=$2 WHERE id=$3',
        [timeUsed, 'verbal', s.id]
      );
    } else {
      const started = s.verbal_started_at ? new Date(s.verbal_started_at) : new Date(s.started_at);
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
  } finally { client.release(); }
});

// POST /api/exam/start-section — record when student starts a section
router.post('/start-section', async (req, res) => {
  const { session_token, section } = req.body;
  if (!session_token || !section) return res.status(400).json({ error: 'Required fields missing' });
  try {
    const sess = await pool.query("SELECT id FROM student_sessions WHERE session_token=$1 AND status='active'", [session_token]);
    if (!sess.rows.length) return res.status(403).json({ error: 'Invalid session' });
    const col = section === 'aptitude_reasoning' ? 'aptitude_started_at' : 'verbal_started_at';
    await pool.query('UPDATE student_sessions SET ' + col + '=NOW(), current_section=$1 WHERE id=$2', [section, sess.rows[0].id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// Auto-submit active sessions when end_time passes — runs every 60 seconds
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
