const express = require('express');
const router = express.Router();
const multer = require('multer');
const XLSX = require('xlsx');
const pool = require('../db/pool');
const { authenticate, auditLog } = require('../middleware/auth');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// GET /api/questions
router.get('/', authenticate, async (req, res) => {
  const { section, topic, difficulty, search, archived, page = 1, limit = 50 } = req.query;
  const offset = (page - 1) * limit;
  const conditions = ['q.is_active = true'];
  const params = [];
  let i = 1;

  if (archived === 'true') { conditions[0] = 'q.is_archived = true'; }

  // Trainer-wise ownership
  if (req.trainer.role !== 'super_admin') {
    conditions.push(`q.trainer_id = $${i++}`);
    params.push(req.trainer.id);
  }

  if (section) { conditions.push(`q.section = $${i++}`); params.push(section); }
  if (topic)   { conditions.push(`q.topic ILIKE $${i++}`); params.push('%' + topic + '%'); }
  if (difficulty) { conditions.push(`q.difficulty = $${i++}`); params.push(difficulty); }
  if (search)  { conditions.push(`q.question_text ILIKE $${i++}`); params.push('%' + search + '%'); }

  const where = conditions.join(' AND ');
  params.push(limit, offset);

  try {
    const countRes = await pool.query('SELECT COUNT(*) FROM questions q WHERE ' + where, params.slice(0, -2));
    const dataRes  = await pool.query(
      'SELECT q.*, t.name as trainer_name FROM questions q LEFT JOIN trainers t ON q.trainer_id = t.id WHERE ' + where + ' ORDER BY q.created_at DESC LIMIT $' + i + ' OFFSET $' + (i+1),
      params
    );
    res.json({ questions: dataRes.rows, total: parseInt(countRes.rows[0].count), page: parseInt(page), limit: parseInt(limit) });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// GET /api/questions/topics
router.get('/topics', authenticate, async (req, res) => {
  const { section } = req.query;
  try {
    const result = await pool.query(
      'SELECT DISTINCT topic, section FROM questions WHERE is_active=true ' + (section ? 'AND section=$1 ' : '') + 'ORDER BY topic',
      section ? [section] : []
    );
    res.json({ topics: result.rows });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// GET /api/questions/template
router.get('/template', authenticate, (req, res) => {
  const sample = [
    { section: 'aptitude_reasoning', topic: 'Time & Work', question_text: 'A can do a job in 10 days. B can do it in 15 days. How many days to complete together?', option_a: '4', option_b: '5', option_c: '6', option_d: '7', correct_option: 'C', explanation: 'Combined rate = 1/10 + 1/15 = 1/6', difficulty: 'medium' },
    { section: 'verbal', topic: 'Para Jumbles', question_text: 'Arrange: P Q R S', option_a: 'PRQS', option_b: 'PQRS', option_c: 'QPRS', option_d: 'SPQR', correct_option: 'B', explanation: '', difficulty: 'easy' }
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sample), 'Questions');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename=question_template.xlsx');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// POST /api/questions
router.post('/', authenticate, async (req, res) => {
  const { section, topic, question_text, option_a, option_b, option_c, option_d, correct_option, explanation, difficulty, image_url } = req.body;
  if (!section || !topic || !question_text || !option_a || !option_b || !option_c || !option_d || !correct_option)
    return res.status(400).json({ error: 'All question fields required' });
  try {
    const dup = await pool.query('SELECT id FROM questions WHERE question_text=$1 AND section=$2 AND is_active=true', [question_text.trim(), section]);
    if (dup.rows.length) return res.status(400).json({ error: 'Duplicate question already exists', duplicate_id: dup.rows[0].id });
    const result = await pool.query(
      'INSERT INTO questions (trainer_id,section,topic,question_text,option_a,option_b,option_c,option_d,correct_option,explanation,difficulty,image_url) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *',
      [req.trainer.id, section, topic, question_text.trim(), option_a, option_b, option_c, option_d, correct_option.toUpperCase(), explanation, difficulty || 'medium', image_url]
    );
    await auditLog(req.trainer.id, 'CREATE_QUESTION', 'question', result.rows[0].id, { topic }, req.ip);
    res.status(201).json({ question: result.rows[0] });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// POST /api/questions/upload
router.post('/upload', authenticate, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);
    const errors = [], inserted = [], duplicates = [];
    const requiredCols = ['section','topic','question_text','option_a','option_b','option_c','option_d','correct_option'];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]; const rowNum = i + 2;
      const missing = requiredCols.filter(col => !row[col] || String(row[col]).trim() === '');
      if (missing.length) { errors.push({ row: rowNum, error: 'Missing: ' + missing.join(', ') }); continue; }
      const correct = String(row.correct_option).trim().toUpperCase();
      if (!['A','B','C','D'].includes(correct)) { errors.push({ row: rowNum, error: 'correct_option must be A/B/C/D' }); continue; }
      const section = String(row.section).trim().toLowerCase().replace(/\s+/g,'_');
      if (!['aptitude_reasoning','verbal'].includes(section)) { errors.push({ row: rowNum, error: 'Invalid section: ' + row.section }); continue; }
      try {
        const dup = await pool.query('SELECT id FROM questions WHERE question_text=$1 AND is_active=true', [String(row.question_text).trim()]);
        if (dup.rows.length) { duplicates.push({ row: rowNum, question: String(row.question_text).substring(0,60) }); continue; }
        const res2 = await pool.query(
          'INSERT INTO questions (trainer_id,section,topic,tag,question_text,option_a,option_b,option_c,option_d,correct_option,explanation,difficulty) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id',
          [req.trainer.id, section, String(row.topic).trim(), row.tag ? String(row.tag).trim().toUpperCase() : null, String(row.question_text).trim(), String(row.option_a), String(row.option_b), String(row.option_c), String(row.option_d), correct, row.explanation||null, row.difficulty||'medium']
        );
        inserted.push(res2.rows[0].id);
      } catch (e) { errors.push({ row: rowNum, error: e.message }); }
    }
    await auditLog(req.trainer.id, 'UPLOAD_QUESTIONS', 'question', null, { total: rows.length, inserted: inserted.length, errors: errors.length }, req.ip);
    res.json({ message: 'Upload complete', inserted: inserted.length, duplicates: duplicates.length, errors: errors.length, error_details: errors, duplicate_details: duplicates });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to process file' }); }
});

// PATCH /api/questions/:id — update (with lock check)
router.patch('/:id', authenticate, async (req, res) => {
  try {
    const check = await pool.query('SELECT is_locked, trainer_id FROM questions WHERE id=$1', [req.params.id]);
    if (!check.rows.length) return res.status(404).json({ error: 'Question not found' });
    const q = check.rows[0];
    if (q.is_locked && req.trainer.role !== 'super_admin')
      return res.status(403).json({ error: 'Question is locked — used in a published exam. Contact super admin.' });
    if (req.trainer.role !== 'super_admin' && q.trainer_id !== req.trainer.id)
      return res.status(403).json({ error: 'You can only edit your own questions' });

    const fields = ['section','topic','question_text','option_a','option_b','option_c','option_d','correct_option','explanation','difficulty','image_url','is_archived','is_locked'];
    const updates = []; const values = []; let i = 1;
    for (const f of fields) { if (req.body[f] !== undefined) { updates.push(f + '=$' + i++); values.push(req.body[f]); } }
    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
    values.push(req.params.id);
    const result = await pool.query('UPDATE questions SET ' + updates.join(',') + ', updated_at=NOW() WHERE id=$' + i + ' RETURNING *', values);
    await auditLog(req.trainer.id, 'UPDATE_QUESTION', 'question', req.params.id, req.body, req.ip);
    res.json({ question: result.rows[0] });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// DELETE /api/questions/:id
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const check = await pool.query('SELECT trainer_id FROM questions WHERE id=$1', [req.params.id]);
    if (!check.rows.length) return res.status(404).json({ error: 'Question not found' });
    if (req.trainer.role !== 'super_admin' && check.rows[0].trainer_id !== req.trainer.id)
      return res.status(403).json({ error: 'You can only delete your own questions' });
    await pool.query('UPDATE questions SET is_active=false, updated_at=NOW() WHERE id=$1', [req.params.id]);
    await auditLog(req.trainer.id, 'DELETE_QUESTION', 'question', req.params.id, {}, req.ip);
    res.json({ message: 'Question deleted' });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});


const TOPIC_TAG_MAP = {
  'Number System (General)': 'NS', 'Unit Digit': 'UD', 'Remainder Theorem': 'RT',
  'Factorial': 'FAC', 'LCM & HCF': 'LCM', 'Divisibility': 'DIV',
  'Profit & Loss': 'PL', 'Discount': 'DISC', 'Simple Interest': 'SI',
  'Compound Interest': 'CI', 'Time & Work': 'TW', 'Pipes & Cisterns': 'PC',
  'Speed Distance Time': 'SDT', 'Boats & Streams': 'BS', 'Trains': 'TRN',
  'Percentage': 'PCT', 'Ratio & Proportion': 'RP', 'Averages': 'AVG',
  'Mixtures & Alligation': 'MIX', 'Partnership': 'PART', 'Ages': 'AGE',
  'Simplification': 'SIMP', 'Approximation': 'APPRX', 'Quadratic Equations': 'QE',
  'Surds & Indices': 'SURD', 'Mensuration 2D': 'MEN2', 'Mensuration 3D': 'MEN3',
  'Probability': 'PROB', 'Permutation & Combination': 'PNC', 'Series & Sequences': 'SEQ',
  'Coding Decoding': 'CD', 'Blood Relations': 'BR', 'Direction Sense': 'DS',
  'Seating Arrangement': 'SEAT', 'Puzzles': 'PUZ', 'Syllogism': 'SYL',
  'Inequalities': 'INEQ', 'Input Output': 'IO', 'Analogies (Reasoning)': 'ANA',
  'Classification': 'CLS', 'Number Series': 'NSER', 'Statement & Conclusion': 'STC',
  'Cause & Effect': 'CAE', 'Critical Reasoning': 'CR',
  'Synonyms': 'SYN', 'Antonyms': 'ANT', 'Analogies (Verbal)': 'VANA',
  'Spotting Errors': 'SE', 'Sentence Correction': 'SCOR', 'Fill in the Blanks': 'FIB',
  'Cloze Test': 'CLZ', 'Idioms & Phrases': 'IP', 'One Word Substitution': 'OWS',
  'Word Meaning in Context': 'WMC', 'Para Jumbles': 'PJ', 'Para Summary': 'PS'
};

// POST /api/questions/fix-tags — one time fix for null tags
router.post('/fix-tags', authenticate, async (req, res) => {
  if (!['master_admin','super_admin'].includes(req.trainer.role))
    return res.status(403).json({ error: 'Not authorized' });
  try {
    let updated = 0;
    for (const [topic, tag] of Object.entries(TOPIC_TAG_MAP)) {
      const result = await pool.query(
        'UPDATE questions SET tag=$1 WHERE topic=$2 AND (tag IS NULL OR tag=\'\') RETURNING id',
        [tag, topic]
      );
      updated += result.rowCount;
    }
    res.json({ message: 'Tags fixed!', updated });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

module.exports = router;
