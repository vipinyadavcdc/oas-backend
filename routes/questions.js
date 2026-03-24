const express = require('express');
const router = express.Router();
const multer = require('multer');
const XLSX = require('xlsx');
const pool = require('../db/pool');
const { authenticate, auditLog } = require('../middleware/auth');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Master tag list — single source of truth
const MASTER_TAGS = {
  'Number System (General)': 'NS',
  'Unit Digit': 'UD',
  'Remainder Theorem': 'RT',
  'Factorial': 'FAC',
  'LCM & HCF': 'LCM',
  'Divisibility': 'DIV',
  'Profit & Loss': 'PL',
  'Discount': 'DISC',
  'Simple Interest': 'SI',
  'Compound Interest': 'CI',
  'Time & Work': 'TW',
  'Pipes & Cisterns': 'PC',
  'Speed Distance Time': 'SDT',
  'Boats & Streams': 'BS',
  'Trains': 'TRN',
  'Percentage': 'PCT',
  'Ratio & Proportion': 'RP',
  'Averages': 'AVG',
  'Mixtures & Alligation': 'MIX',
  'Partnership': 'PART',
  'Ages': 'AGE',
  'Simplification': 'SIMP',
  'Approximation': 'APPRX',
  'Quadratic Equations': 'QE',
  'Surds & Indices': 'SURD',
  'Mensuration 2D': 'MEN2',
  'Mensuration 3D': 'MEN3',
  'Probability': 'PROB',
  'Permutation & Combination': 'PNC',
  'Data Interpretation': 'DI',
  'Series & Sequences': 'SEQ',
  'Coding Decoding': 'CD',
  'Blood Relations': 'BR',
  'Direction Sense': 'DS',
  'Seating Arrangement': 'SEAT',
  'Puzzles': 'PUZ',
  'Syllogism': 'SYL',
  'Inequalities': 'INEQ',
  'Input Output': 'IO',
  'Analogies (Reasoning)': 'ANA',
  'Classification': 'CLS',
  'Number Series': 'NSER',
  'Statement & Conclusion': 'STC',
  'Cause & Effect': 'CAE',
  'Critical Reasoning': 'CR',
  'Synonyms': 'SYN',
  'Antonyms': 'ANT',
  'Analogies (Verbal)': 'VANA',
  'Spotting Errors': 'SE',
  'Sentence Correction': 'SCOR',
  'Fill in the Blanks': 'FIB',
  'Cloze Test': 'CLZ',
  'Idioms & Phrases': 'IP',
  'One Word Substitution': 'OWS',
  'Word Meaning in Context': 'WMC',
  'Reading Comprehension': 'RC',
  'Para Jumbles': 'PJ',
  'Para Summary': 'PS',
};

const VALID_TOPICS = Object.keys(MASTER_TAGS);

// GET /api/questions
router.get('/', authenticate, async (req, res) => {
  const { section, topic, tag, difficulty, search, archived, page = 1, limit = 50 } = req.query;
  const offset = (page - 1) * limit;
  const conditions = ['q.is_active = true'];
  const params = [];
  let i = 1;

  if (archived === 'true') { conditions[0] = 'q.is_archived = true'; }

  if (req.trainer.role !== 'super_admin') {
    conditions.push(`q.trainer_id = $${i++}`);
    params.push(req.trainer.id);
  }

  if (section)    { conditions.push(`q.section = $${i++}`); params.push(section); }
  if (topic)      { conditions.push(`q.topic ILIKE $${i++}`); params.push('%' + topic + '%'); }
  if (tag)        { conditions.push(`q.tag = $${i++}`); params.push(tag.toUpperCase()); }
  if (difficulty) { conditions.push(`q.difficulty = $${i++}`); params.push(difficulty); }
  if (search)     { conditions.push(`q.question_text ILIKE $${i++}`); params.push('%' + search + '%'); }

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
      'SELECT DISTINCT topic, tag, section FROM questions WHERE is_active=true ' + (section ? 'AND section=$1 ' : '') + 'ORDER BY topic',
      section ? [section] : []
    );
    res.json({ topics: result.rows });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// GET /api/questions/tags — return master tag list
router.get('/tags', authenticate, (req, res) => {
  const list = Object.entries(MASTER_TAGS).map(([topic, tag]) => ({ topic, tag }));
  res.json({ tags: list });
});

// GET /api/questions/template — serve the pre-built Excel template
router.get('/template', authenticate, (req, res) => {
  const fs = require('fs');
  const path = require('path');
  const templatePath = path.join(__dirname, '../db/question_template.xlsx');
  if (fs.existsSync(templatePath)) {
    res.setHeader('Content-Disposition', 'attachment; filename=question_template.xlsx');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    return res.send(fs.readFileSync(templatePath));
  }
  // Fallback: generate simple template
  const sample = [
    { section: 'aptitude_reasoning', topic: 'Time & Work', tag: 'TW', question_text: 'Sample question?', option_a: 'A', option_b: 'B', option_c: 'C', option_d: 'D', correct_option: 'A', difficulty: 'medium' },
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
  const { section, topic, question_text, option_a, option_b, option_c, option_d, correct_option, difficulty, image_url } = req.body;
  if (!section || !topic || !question_text || !option_a || !option_b || !option_c || !option_d || !correct_option)
    return res.status(400).json({ error: 'All question fields required' });

  // Validate topic and get tag
  const tag = MASTER_TAGS[topic];
  if (!tag) return res.status(400).json({ error: 'Invalid topic. Must be from master list.', valid_topics: VALID_TOPICS });

  try {
    const dup = await pool.query('SELECT id FROM questions WHERE question_text=$1 AND section=$2 AND is_active=true', [question_text.trim(), section]);
    if (dup.rows.length) return res.status(400).json({ error: 'Duplicate question already exists' });
    const result = await pool.query(
      'INSERT INTO questions (trainer_id,section,topic,tag,question_text,option_a,option_b,option_c,option_d,correct_option,difficulty,image_url) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *',
      [req.trainer.id, section, topic, tag, question_text.trim(), option_a, option_b, option_c, option_d, correct_option.toUpperCase(), difficulty || 'medium', image_url]
    );
    await auditLog(req.trainer.id, 'CREATE_QUESTION', 'question', result.rows[0].id, { topic, tag }, req.ip);
    res.status(201).json({ question: result.rows[0] });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
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
      const row = rows[i];
      const rowNum = i + 2;

      // Skip instruction row
      if (String(row.section || '').includes('aptitude_reasoning OR')) continue;

      const missing = requiredCols.filter(col => !row[col] || String(row[col]).trim() === '');
      if (missing.length) { errors.push({ row: rowNum, error: 'Missing: ' + missing.join(', ') }); continue; }

      const correct = String(row.correct_option).trim().toUpperCase();
      if (!['A','B','C','D'].includes(correct)) { errors.push({ row: rowNum, error: 'correct_option must be A/B/C/D' }); continue; }

      const section = String(row.section).trim().toLowerCase().replace(/\s+/g,'_');
      if (!['aptitude_reasoning','verbal'].includes(section)) { errors.push({ row: rowNum, error: 'Invalid section: ' + row.section }); continue; }

      // Validate topic against master list
      const topic = String(row.topic).trim();
      const tag = MASTER_TAGS[topic];
      if (!tag) { errors.push({ row: rowNum, error: 'Invalid topic "' + topic + '". Must be from master tag list.' }); continue; }

      try {
        const dup = await pool.query('SELECT id FROM questions WHERE question_text=$1 AND is_active=true', [String(row.question_text).trim()]);
        if (dup.rows.length) { duplicates.push({ row: rowNum, question: String(row.question_text).substring(0,60) }); continue; }
        const res2 = await pool.query(
          'INSERT INTO questions (trainer_id,section,topic,tag,question_text,option_a,option_b,option_c,option_d,correct_option,difficulty) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id',
          [req.trainer.id, section, topic, tag, String(row.question_text).trim(), String(row.option_a), String(row.option_b), String(row.option_c), String(row.option_d), correct, row.difficulty||'medium']
        );
        inserted.push(res2.rows[0].id);
      } catch (e) { errors.push({ row: rowNum, error: e.message }); }
    }

    await auditLog(req.trainer.id, 'UPLOAD_QUESTIONS', 'question', null, { total: rows.length, inserted: inserted.length, errors: errors.length }, req.ip);
    res.json({ message: 'Upload complete', inserted: inserted.length, duplicates: duplicates.length, errors: errors.length, error_details: errors, duplicate_details: duplicates });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to process file' }); }
});

// PATCH /api/questions/:id
router.patch('/:id', authenticate, async (req, res) => {
  try {
    const check = await pool.query('SELECT is_locked, trainer_id FROM questions WHERE id=$1', [req.params.id]);
    if (!check.rows.length) return res.status(404).json({ error: 'Question not found' });
    const q = check.rows[0];
    if (q.is_locked && req.trainer.role !== 'super_admin')
      return res.status(403).json({ error: 'Question is locked — used in a published exam. Contact super admin.' });
    if (req.trainer.role !== 'super_admin' && q.trainer_id !== req.trainer.id)
      return res.status(403).json({ error: 'You can only edit your own questions' });

    // If topic is being updated, recalculate tag
    if (req.body.topic) {
      const tag = MASTER_TAGS[req.body.topic];
      if (!tag) return res.status(400).json({ error: 'Invalid topic. Must be from master list.' });
      req.body.tag = tag;
    }

    const fields = ['section','topic','tag','question_text','option_a','option_b','option_c','option_d','correct_option','difficulty','image_url','is_archived','is_locked'];
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

module.exports = router;
