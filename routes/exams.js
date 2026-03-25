const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { authenticate, requireSuperAdmin, auditLog } = require('../middleware/auth');

const genRoomCode = () => Math.random().toString(36).substring(2, 8).toUpperCase();

// GET /api/exams
router.get('/', authenticate, async (req, res) => {
  const { status, university, exam_type } = req.query;
  const conditions = [];
  const params = [];
  let i = 1;
  if (!['super_admin','master_admin'].includes(req.trainer.role)) {
    conditions.push('e.trainer_id=$' + i++);
    params.push(req.trainer.id);
  }
  if (status)     { conditions.push('e.status=$' + i++); params.push(status); }
  if (university) { conditions.push("(e.university=$" + i++ + " OR e.university='BOTH')"); params.push(university); }
  if (exam_type)  { conditions.push('e.exam_type=$' + i++); params.push(exam_type); }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  try {
    const result = await pool.query(
      'SELECT e.*, t.name as trainer_name, (SELECT COUNT(*) FROM student_sessions s WHERE s.exam_id=e.id) as student_count FROM exams e LEFT JOIN trainers t ON e.trainer_id=t.id ' + where + ' ORDER BY e.created_at DESC',
      params
    );
    res.json({ exams: result.rows });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// GET /api/exams/:id
router.get('/:id', authenticate, async (req, res) => {
  try {
    const result = await pool.query('SELECT e.*, t.name as trainer_name FROM exams e LEFT JOIN trainers t ON e.trainer_id=t.id WHERE e.id=$1', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Exam not found' });
    const questions = await pool.query('SELECT eq.sequence_order, eq.marks, q.* FROM exam_questions eq JOIN questions q ON eq.question_id=q.id WHERE eq.exam_id=$1 ORDER BY eq.sequence_order', [req.params.id]);
    res.json({ exam: result.rows[0], questions: questions.rows });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// POST /api/exams — supports question_spec for random selection
router.post('/', authenticate, async (req, res) => {
  const {
    title, description, exam_type, university, department, section_filter,
    duration_minutes, start_time, end_time, marks_per_question,
    negative_marking, negative_marks, aptitude_count, verbal_count,
    randomize_questions, randomize_options,
    aptitude_time_minutes, verbal_time_minutes, device_allowed,
    question_ids,
    question_spec
  } = req.body;

  if (!title || !exam_type || !university || !duration_minutes)
    return res.status(400).json({ error: 'title, exam_type, university, duration_minutes required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const room_code = genRoomCode();

    // Resolve question IDs
    let finalQIds = question_ids || [];

    if (question_spec && question_spec.length > 0) {
      finalQIds = [];
      for (const spec of question_spec) {
        // Randomly pick `count` questions matching tag + difficulty
        const result = await client.query(
          `SELECT id FROM questions
           WHERE tag=$1 AND difficulty=$2 AND is_active=true AND is_archived=false AND is_locked=false
           ORDER BY RANDOM()
           LIMIT $3`,
          [spec.tag, spec.difficulty, spec.count]
        );
        if (result.rows.length < spec.count) {
          await client.query('ROLLBACK');
          return res.status(400).json({
            error: `Not enough questions: ${spec.tag} ${spec.difficulty} needs ${spec.count}, only ${result.rows.length} available`
          });
        }
        finalQIds.push(...result.rows.map(r => r.id));
      }
    }

    const total = finalQIds.length;
    const examResult = await client.query(
      `INSERT INTO exams (trainer_id,title,description,exam_type,university,department,section_filter,
        duration_minutes,start_time,end_time,room_code,marks_per_question,negative_marking,negative_marks,
        total_questions,aptitude_count,verbal_count,randomize_questions,randomize_options,
        aptitude_time_minutes,verbal_time_minutes,device_allowed)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) RETURNING *`,
      [req.trainer.id, title, description, exam_type, university, department, section_filter,
       duration_minutes, start_time||null, end_time||null, room_code,
       marks_per_question||1, negative_marking||false, negative_marks||0.25,
       total, aptitude_count||0, verbal_count||0,
       randomize_questions!==false, randomize_options!==false,
       aptitude_time_minutes||0, verbal_time_minutes||0, device_allowed||'both']
    );
    const exam = examResult.rows[0];

    for (let i = 0; i < finalQIds.length; i++) {
      await client.query(
        'INSERT INTO exam_questions (exam_id,question_id,sequence_order,marks) VALUES ($1,$2,$3,$4)',
        [exam.id, finalQIds[i], i+1, marks_per_question||1]
      );
      await client.query('UPDATE questions SET usage_count=usage_count+1 WHERE id=$1', [finalQIds[i]]);
    }

    await client.query('COMMIT');
    await auditLog(req.trainer.id, 'CREATE_EXAM', 'exam', exam.id, { title, total }, req.ip);
    res.status(201).json({ exam });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  } finally { client.release(); }
});

// PATCH /api/exams/:id
router.patch('/:id', authenticate, async (req, res) => {
  const allowed = ['title','description','exam_type','university','department','section_filter',
    'duration_minutes','start_time','end_time','marks_per_question','negative_marking',
    'negative_marks','randomize_questions','randomize_options','status',
    'aptitude_time_minutes','verbal_time_minutes','device_allowed'];
  const updates = []; const values = []; let i = 1;
  for (const f of allowed) {
    if (req.body[f] !== undefined) { updates.push(f + '=$' + i++); values.push(req.body[f]); }
  }
  if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
  values.push(req.params.id);
  try {
    const result = await pool.query(
      'UPDATE exams SET ' + updates.join(',') + ', updated_at=NOW() WHERE id=$' + i + ' RETURNING *',
      values
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Exam not found' });
    await auditLog(req.trainer.id, 'UPDATE_EXAM', 'exam', req.params.id, req.body, req.ip);
    res.json({ exam: result.rows[0] });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// POST /api/exams/:id/publish
router.post('/:id/publish', authenticate, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      "UPDATE exams SET status='published', updated_at=NOW() WHERE id=$1 AND (trainer_id=$2 OR $3 IN ('super_admin','master_admin')) RETURNING *",
      [req.params.id, req.trainer.id, req.trainer.role]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Exam not found or unauthorized' });
    await client.query(
      'UPDATE questions SET is_locked=true WHERE id IN (SELECT question_id FROM exam_questions WHERE exam_id=$1)',
      [req.params.id]
    );
    await client.query('COMMIT');
    await auditLog(req.trainer.id, 'PUBLISH_EXAM', 'exam', req.params.id, {}, req.ip);
    res.json({ exam: result.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Server error' });
  } finally { client.release(); }
});

// POST /api/exams/:id/clone
router.post('/:id/clone', authenticate, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const orig = await client.query('SELECT * FROM exams WHERE id=$1', [req.params.id]);
    if (!orig.rows.length) return res.status(404).json({ error: 'Exam not found' });
    const e = orig.rows[0];
    const cloned = await client.query(
      `INSERT INTO exams (trainer_id,title,description,exam_type,university,department,section_filter,
        duration_minutes,marks_per_question,negative_marking,negative_marks,total_questions,
        aptitude_count,verbal_count,randomize_questions,randomize_options)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [req.trainer.id, e.title+' (Copy)', e.description, e.exam_type, e.university,
       e.department, e.section_filter, e.duration_minutes, e.marks_per_question,
       e.negative_marking, e.negative_marks, e.total_questions,
       e.aptitude_count, e.verbal_count, e.randomize_questions, e.randomize_options]
    );
    const origQs = await client.query('SELECT * FROM exam_questions WHERE exam_id=$1 ORDER BY sequence_order', [req.params.id]);
    for (const q of origQs.rows) {
      await client.query(
        'INSERT INTO exam_questions (exam_id,question_id,sequence_order,marks) VALUES ($1,$2,$3,$4)',
        [cloned.rows[0].id, q.question_id, q.sequence_order, q.marks]
      );
    }
    await client.query('COMMIT');
    await auditLog(req.trainer.id, 'CLONE_EXAM', 'exam', cloned.rows[0].id, { cloned_from: req.params.id }, req.ip);
    res.status(201).json({ exam: cloned.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Server error' });
  } finally { client.release(); }
});

// POST /api/exams/:id/force-submit-all
router.post('/:id/force-submit-all', authenticate, requireSuperAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const active = await client.query("SELECT id FROM student_sessions WHERE exam_id=$1 AND status='active'", [req.params.id]);
    for (const s of active.rows) {
      await client.query("UPDATE student_sessions SET status='auto_submitted', submitted_at=NOW() WHERE id=$1", [s.id]);
      await calculateResult(client, s.id, req.params.id);
    }
    await client.query('COMMIT');
    await auditLog(req.trainer.id, 'FORCE_SUBMIT_ALL', 'exam', req.params.id, { count: active.rows.length }, req.ip);
    res.json({ message: 'Force submitted ' + active.rows.length + ' students' });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Server error' });
  } finally { client.release(); }
});

async function calculateResult(client, sessionId, examId) {
  const exam = await client.query('SELECT * FROM exams WHERE id=$1', [examId]);
  const answers = await client.query(
    'SELECT sa.*, q.correct_option, q.section FROM student_answers sa JOIN questions q ON sa.question_id=q.id WHERE sa.session_id=$1',
    [sessionId]
  );
  let correct=0, incorrect=0, skipped=0, aptitude_score=0, verbal_score=0;
  const marks = parseFloat(exam.rows[0].marks_per_question);
  const neg = exam.rows[0].negative_marking ? parseFloat(exam.rows[0].negative_marks) : 0;
  for (const a of answers.rows) {
    if (!a.selected_option) { skipped++; continue; }
    if (a.selected_option === a.correct_option) {
      correct++;
      if (a.section === 'aptitude_reasoning') aptitude_score += marks;
      else verbal_score += marks;
    } else {
      incorrect++;
      if (a.section === 'aptitude_reasoning') aptitude_score -= neg;
      else verbal_score -= neg;
    }
  }
  const total = answers.rows.length;
  const raw_score = correct * marks - incorrect * neg;
  const max_score = total * marks;
  const percentage = max_score > 0 ? (raw_score / max_score) * 100 : 0;
  await client.query(
    `INSERT INTO exam_results
      (session_id,exam_id,total_questions,attempted,correct,incorrect,skipped,raw_score,final_score,max_score,percentage,aptitude_score,verbal_score)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (session_id) DO UPDATE SET
      correct=$5,incorrect=$6,attempted=$4,skipped=$7,raw_score=$8,final_score=$9,max_score=$10,percentage=$11`,
    [sessionId, examId, total, correct+incorrect, correct, incorrect, skipped,
     raw_score, raw_score, max_score, percentage.toFixed(2), aptitude_score, verbal_score]
  );
}


// POST /api/exams/:id/end — end exam and auto-submit all active students
router.post('/:id/end', authenticate, async (req, res) => {
  if (!['super_admin','master_admin'].includes(req.trainer.role))
    return res.status(403).json({ error: 'Not authorized' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const active = await client.query(
      "SELECT id FROM student_sessions WHERE exam_id=$1 AND status='active'", [req.params.id]
    );
    for (const s of active.rows) {
      const timeTaken = await client.query(
        'SELECT EXTRACT(EPOCH FROM (NOW() - started_at))::int as secs FROM student_sessions WHERE id=$1', [s.id]
      );
      await client.query(
        "UPDATE student_sessions SET status='auto_submitted', submitted_at=NOW(), time_taken_seconds=$1 WHERE id=$2",
        [timeTaken.rows[0].secs, s.id]
      );
      await calculateResult(client, s.id, req.params.id);
    }
    await client.query("UPDATE exams SET status='ended', updated_at=NOW() WHERE id=$1", [req.params.id]);
    await client.query('COMMIT');
    await auditLog(req.trainer.id, 'END_EXAM', 'exam', req.params.id, { count: active.rows.length }, req.ip);
    res.json({ message: 'Exam ended. ' + active.rows.length + ' students auto-submitted.' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  } finally { client.release(); }
});

// POST /api/exams/:id/extend-time — add minutes to all active students
router.post('/:id/extend-time', authenticate, async (req, res) => {
  if (!['super_admin','master_admin'].includes(req.trainer.role))
    return res.status(403).json({ error: 'Not authorized' });
  const { minutes } = req.body;
  if (!minutes || minutes < 1) return res.status(400).json({ error: 'Invalid minutes' });
  try {
    const active = await pool.query(
      "SELECT id, session_token FROM student_sessions WHERE exam_id=$1 AND status='active'", [req.params.id]
    );
    // Store extension in violations table as a special record for heartbeat pickup
    for (const s of active.rows) {
      await pool.query(
        "INSERT INTO violations (session_id, violation_type, details) VALUES ($1, 'time_extended', $2)",
        [s.id, JSON.stringify({ minutes, granted_at: new Date().toISOString() })]
      );
    }
    await auditLog(req.trainer.id, 'EXTEND_TIME', 'exam', req.params.id, { minutes, students: active.rows.length }, req.ip);
    res.json({ message: '+' + minutes + ' minutes added to ' + active.rows.length + ' active students.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/exams/:id — hard delete exam and all related data
router.delete('/:id', authenticate, async (req, res) => {
  if (req.trainer.role !== 'master_admin')
    return res.status(403).json({ error: 'Only master admin can delete exams' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Delete in order to respect foreign keys
    await client.query('DELETE FROM violations WHERE session_id IN (SELECT id FROM student_sessions WHERE exam_id=$1)', [req.params.id]);
    await client.query('DELETE FROM heartbeats WHERE session_id IN (SELECT id FROM student_sessions WHERE exam_id=$1)', [req.params.id]);
    await client.query('DELETE FROM student_answers WHERE session_id IN (SELECT id FROM student_sessions WHERE exam_id=$1)', [req.params.id]);
    await client.query('DELETE FROM exam_results WHERE exam_id=$1', [req.params.id]);
    await client.query('DELETE FROM student_sessions WHERE exam_id=$1', [req.params.id]);
    await client.query('DELETE FROM exam_questions WHERE exam_id=$1', [req.params.id]);
    await client.query('DELETE FROM exams WHERE id=$1', [req.params.id]);
    await client.query('COMMIT');
    await auditLog(req.trainer.id, 'DELETE_EXAM', 'exam', req.params.id, {}, req.ip);
    res.json({ message: 'Exam permanently deleted' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  } finally { client.release(); }
});


// POST /api/exams/:id/unpublish — move back to draft
router.post('/:id/unpublish', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      "UPDATE exams SET status='draft', updated_at=NOW() WHERE id=$1 AND (trainer_id=$2 OR $3 IN ('super_admin','master_admin')) RETURNING *",
      [req.params.id, req.trainer.id, req.trainer.role]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Exam not found or unauthorized' });
    await auditLog(req.trainer.id, 'UNPUBLISH_EXAM', 'exam', req.params.id, {}, req.ip);
    res.json({ exam: result.rows[0] });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// POST /api/exams/:id/end — end exam and auto-submit all active students
router.post('/:id/end', authenticate, requireSuperAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const active = await client.query(
      "SELECT id FROM student_sessions WHERE exam_id=$1 AND status='active'",
      [req.params.id]
    );
    for (const s of active.rows) {
      const time_taken = await client.query(
        'SELECT EXTRACT(EPOCH FROM (NOW() - started_at))::int as secs FROM student_sessions WHERE id=$1',
        [s.id]
      );
      await client.query(
        "UPDATE student_sessions SET status='auto_submitted', submitted_at=NOW(), time_taken_seconds=$1 WHERE id=$2",
        [time_taken.rows[0].secs, s.id]
      );
      await calculateResult(client, s.id, req.params.id);
    }
    await client.query("UPDATE exams SET status='ended', updated_at=NOW() WHERE id=$1", [req.params.id]);
    await client.query('COMMIT');
    await auditLog(req.trainer.id, 'END_EXAM', 'exam', req.params.id, { auto_submitted: active.rows.length }, req.ip);
    res.json({ message: 'Exam ended. ' + active.rows.length + ' students auto-submitted.' });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Server error' });
  } finally { client.release(); }
});

// POST /api/exams/:id/extend-time — add extra minutes to all active students
router.post('/:id/extend-time', authenticate, requireSuperAdmin, async (req, res) => {
  const { extra_minutes } = req.body;
  if (!extra_minutes || extra_minutes < 1) return res.status(400).json({ error: 'Invalid minutes' });
  try {
    const active = await pool.query(
      "SELECT id FROM student_sessions WHERE exam_id=$1 AND status='active'",
      [req.params.id]
    );
    await pool.query(
      'INSERT INTO violations (session_id, violation_type, details) SELECT id, $1, $2 FROM student_sessions WHERE exam_id=$3 AND status=$4',
      ['time_extended', JSON.stringify({ extra_minutes }), req.params.id, 'active']
    );
    await auditLog(req.trainer.id, 'EXTEND_TIME', 'exam', req.params.id, { extra_minutes, students: active.rows.length }, req.ip);
    res.json({ message: 'Time extended for ' + active.rows.length + ' students', extra_minutes });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// DELETE /api/exams/:id — hard delete exam and all related data
router.delete('/:id', authenticate, async (req, res) => {
  if (!['master_admin'].includes(req.trainer.role))
    return res.status(403).json({ error: 'Only master admin can delete exams' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Get session ids first
    const sessions = await client.query('SELECT id FROM student_sessions WHERE exam_id=$1', [req.params.id]);
    const sessionIds = sessions.rows.map(s => s.id);
    if (sessionIds.length > 0) {
      await client.query('DELETE FROM student_answers WHERE session_id = ANY($1)', [sessionIds]);
      await client.query('DELETE FROM violations WHERE session_id = ANY($1)', [sessionIds]);
      await client.query('DELETE FROM heartbeats WHERE session_id = ANY($1)', [sessionIds]);
      await client.query('DELETE FROM exam_results WHERE session_id = ANY($1)', [sessionIds]);
      await client.query('DELETE FROM student_sessions WHERE exam_id=$1', [req.params.id]);
    }
    await client.query('DELETE FROM exam_questions WHERE exam_id=$1', [req.params.id]);
    await client.query('DELETE FROM exams WHERE id=$1', [req.params.id]);
    await client.query('COMMIT');
    await auditLog(req.trainer.id, 'DELETE_EXAM', 'exam', req.params.id, { sessions_deleted: sessionIds.length }, req.ip);
    res.json({ message: 'Exam permanently deleted' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  } finally { client.release(); }
});


// DELETE /api/exams/:id — hard delete (master_admin only)
router.delete('/:id', authenticate, async (req, res) => {
  if (!['master_admin'].includes(req.trainer.role))
    return res.status(403).json({ error: 'Only master admin can delete exams' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const exam = await client.query('SELECT * FROM exams WHERE id=$1', [req.params.id]);
    if (!exam.rows.length) return res.status(404).json({ error: 'Exam not found' });
    // Delete in order to respect foreign keys
    await client.query('DELETE FROM violations WHERE session_id IN (SELECT id FROM student_sessions WHERE exam_id=$1)', [req.params.id]);
    await client.query('DELETE FROM heartbeats WHERE session_id IN (SELECT id FROM student_sessions WHERE exam_id=$1)', [req.params.id]);
    await client.query('DELETE FROM student_answers WHERE session_id IN (SELECT id FROM student_sessions WHERE exam_id=$1)', [req.params.id]);
    await client.query('DELETE FROM exam_results WHERE exam_id=$1', [req.params.id]);
    await client.query('DELETE FROM student_sessions WHERE exam_id=$1', [req.params.id]);
    await client.query('DELETE FROM exam_questions WHERE exam_id=$1', [req.params.id]);
    await client.query('DELETE FROM exams WHERE id=$1', [req.params.id]);
    await client.query('COMMIT');
    await auditLog(req.trainer.id, 'DELETE_EXAM', 'exam', req.params.id, { title: exam.rows[0].title }, req.ip);
    res.json({ message: 'Exam permanently deleted' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  } finally { client.release(); }
});

// POST /api/exams/:id/extend-time — add minutes to all active students
router.post('/:id/extend-time', authenticate, async (req, res) => {
  if (!['master_admin','super_admin'].includes(req.trainer.role))
    return res.status(403).json({ error: 'Not authorized' });
  const { minutes } = req.body;
  if (!minutes || minutes < 1) return res.status(400).json({ error: 'Invalid minutes' });
  try {
    const active = await pool.query(
      "SELECT id FROM student_sessions WHERE exam_id=$1 AND status='active'",
      [req.params.id]
    );
    // Store extension as a violation record with type 'time_extended'
    for (const s of active.rows) {
      await pool.query(
        "INSERT INTO violations (session_id, violation_type, details) VALUES ($1, 'time_extended', $2)",
        [s.id, JSON.stringify({ minutes, added_by: req.trainer.name, added_at: new Date() })]
      );
    }
    await auditLog(req.trainer.id, 'EXTEND_TIME', 'exam', req.params.id, { minutes, affected: active.rows.length }, req.ip);
    res.json({ message: `Added ${minutes} minutes to ${active.rows.length} active students` });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

module.exports = router;
module.exports.calculateResult = calculateResult;
