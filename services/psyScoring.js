// CDC OAS — Psychometric Scoring Engine
// Integrated with OAS pool (not separate DB)
// 7+1 dimensional cross-fusion scoring

const pool = require('../db/pool')

// ── STANINE CONVERSION (percentile-based, internationally standardized) ──────
function toStanine(pct) {
  if (pct <= 4)  return 1
  if (pct <= 11) return 2
  if (pct <= 23) return 3
  if (pct <= 40) return 4
  if (pct <= 60) return 5
  if (pct <= 77) return 6
  if (pct <= 89) return 7
  if (pct <= 96) return 8
  return 9
}

function stanineLabel(s) {
  if (s <= 2) return 'Well Below Average'
  if (s === 3) return 'Below Average'
  if (s <= 6) return 'Average'
  if (s === 7) return 'Above Average'
  if (s === 8) return 'Well Above Average'
  return 'Exceptional'
}

function stanineColor(s) {
  if (s <= 2) return '#ef4444'
  if (s === 3) return '#f97316'
  if (s <= 6) return '#eab308'
  if (s === 7) return '#22c55e'
  if (s === 8) return '#16a34a'
  return '#059669'
}

// ── QUESTION METADATA ────────────────────────────────────────────────────────
const QUESTION_META = {
  // Personality reverse-coded items (Big Five IPIP)
  personality_reverse: ['P4','P11','P16','P23','P28','P34','P38','P44','P49'],
  
  // Aptitude correct answers (0-indexed)
  aptitude_correct: {
    A1:2, A2:0, A3:1, A4:2, A5:0,           // Abstract
    A6:1, A7:2, A8:0, A9:1, A10:2,           // Verbal
    A11:0, A12:2, A13:1, A14:0, A15:2,       // Logical
    A16:1, A17:0, A18:2, A19:1, A20:0,       // Numerical
    A21:2, A22:1, A23:0, A24:2, A25:1,       // Spatial
    A26:0, A27:2, A28:1, A29:0, A30:2,       // Language
    A31:1, A32:0, A33:2, A34:1, A35:0,       // Info Tech
    A36:2, A37:1, A38:0, A39:2, A40:1,       // Mechanical
    A41:0, A42:2, A43:1, A44:0, A45:2,       // Perceptual
    A46:1, A47:0, A48:2, A49:1, A50:0,       // Creative
  },
  
  // EQ situational weights [A, B, C, D] — best=9, good=5, neutral=2, poor=0
  eq_weights: {
    EQ1:  [9,5,2,0], EQ2:  [0,9,5,2], EQ3:  [2,9,0,5],
    EQ4:  [5,2,9,0], EQ5:  [9,0,2,5], EQ6:  [0,5,9,2],
    EQ7:  [2,9,5,0], EQ8:  [9,2,0,5], EQ9:  [5,9,2,0],
    EQ10: [0,2,9,5], EQ11: [9,5,0,2], EQ12: [2,0,5,9],
    EQ13: [5,9,2,0], EQ14: [0,2,9,5], EQ15: [9,5,2,0],
    EQ16: [2,9,0,5], EQ17: [5,0,9,2], EQ18: [9,2,5,0],
    EQ19: [0,9,5,2], EQ20: [2,5,0,9],
  }
}

// ── CAREER DIMENSION WEIGHTS ──────────────────────────────────────────────────
const CAREER_WEIGHTS = {
  riasec:      0.25,
  interest:    0.20,
  aptitude:    0.20,
  personality: 0.15,
  mi:          0.10,
  values:      0.10,
}

// ── MAIN SCORING FUNCTION ────────────────────────────────────────────────────
async function calculateScores(sessionId, studentId, answers) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    
    const results = {}
    const byDim = {}
    for (const a of answers) {
      if (!byDim[a.dimension]) byDim[a.dimension] = []
      byDim[a.dimension].push(a)
    }

    // ── 1. ORIENTATION (RIASEC) ──────────────────────────────────────────────
    if (byDim.orientation) {
      const scales = ['realistic','investigative','artistic','social','enterprising','conventional']
      results.orientation = {}
      for (const scale of scales) {
        const items = byDim.orientation.filter(a => a.scale === scale)
        const sum   = items.reduce((acc, a) => acc + (a.response_value || 0), 0)
        const max   = items.length * 5
        const pct   = max > 0 ? (sum / max) * 100 : 0
        const st    = toStanine(pct)
        results.orientation[scale] = { raw: sum, pct, stanine: st, label: stanineLabel(st), color: stanineColor(st) }
        await saveScore(client, sessionId, studentId, 'orientation', scale, sum, pct, st)
      }

      // Holland Code
      const ranked = Object.entries(results.orientation).sort((a,b) => b[1].pct - a[1].pct)
      const code   = ranked.slice(0,3).map(e => e[0][0].toUpperCase()).join('')
      await client.query(
        `INSERT INTO psy_holland_codes (session_id, student_id, code, primary_type, secondary_type, tertiary_type, full_ranking)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (student_id) DO UPDATE SET code=$3, primary_type=$4, secondary_type=$5, tertiary_type=$6, full_ranking=$7`,
        [sessionId, studentId, code, ranked[0]?.[0], ranked[1]?.[0], ranked[2]?.[0], JSON.stringify(ranked.map(e => ({type: e[0], score: e[1]})))]
      )
      results.hollandCode = code
    }

    // ── 2. PERSONALITY (Big Five IPIP) ───────────────────────────────────────
    if (byDim.personality) {
      const scales = ['openness','conscientiousness','extraversion','agreeableness','stability']
      results.personality = {}
      for (const scale of scales) {
        const items = byDim.personality.filter(a => a.scale === scale)
        const sum   = items.reduce((acc, a) => {
          const val = a.response_value || 0
          return acc + (QUESTION_META.personality_reverse.includes(a.question_id) ? (6 - val) : val)
        }, 0)
        const max   = items.length * 5
        const pct   = max > 0 ? (sum / max) * 100 : 0
        const st    = toStanine(pct)
        results.personality[scale] = { raw: sum, pct, stanine: st, label: stanineLabel(st), color: stanineColor(st) }
        await saveScore(client, sessionId, studentId, 'personality', scale, sum, pct, st)
      }
    }

    // ── 3. INTEREST MAPPING ───────────────────────────────────────────────────
    if (byDim.interest) {
      results.interest = {}
      const scales = [...new Set(byDim.interest.map(a => a.scale))]
      for (const scale of scales) {
        const items = byDim.interest.filter(a => a.scale === scale)
        const sum   = items.reduce((acc, a) => acc + (a.response_value || 0), 0)
        const max   = items.length * 5
        const pct   = max > 0 ? (sum / max) * 100 : 0
        const st    = toStanine(pct)
        results.interest[scale] = { raw: sum, pct, stanine: st, label: stanineLabel(st), color: stanineColor(st) }
        await saveScore(client, sessionId, studentId, 'interest', scale, sum, pct, st)
      }
    }

    // ── 4. APTITUDE (performance-based, timed) ────────────────────────────────
    if (byDim.aptitude) {
      results.aptitude = {}
      const scales = [...new Set(byDim.aptitude.map(a => a.scale))]
      for (const scale of scales) {
        const items   = byDim.aptitude.filter(a => a.scale === scale)
        const correct = items.filter(a => QUESTION_META.aptitude_correct[a.question_id] === a.response_value).length
        const total   = items.length
        const pct     = total > 0 ? (correct / total) * 100 : 0
        const st      = toStanine(pct)
        results.aptitude[scale] = { correct, total, pct, stanine: st, label: stanineLabel(st), color: stanineColor(st) }
        await saveScore(client, sessionId, studentId, 'aptitude', scale, correct, pct, st)
      }
      // Compute overall aptitude score
      const aptVals   = Object.values(results.aptitude)
      const avgAptPct = aptVals.reduce((a, v) => a + v.pct, 0) / aptVals.length
      results.aptitude._overall = { pct: avgAptPct, stanine: toStanine(avgAptPct) }
    }

    // ── 5. EMOTIONAL INTELLIGENCE ─────────────────────────────────────────────
    if (byDim.eq) {
      results.eq = {}
      const scales = [...new Set(byDim.eq.map(a => a.scale))]
      for (const scale of scales) {
        const items = byDim.eq.filter(a => a.scale === scale)
        let   total = 0
        let   max   = 0
        for (const a of items) {
          const weights = QUESTION_META.eq_weights[a.question_id]
          if (weights && a.response_value !== null && a.response_value !== undefined) {
            total += weights[a.response_value] || 0
            max   += 9
          }
        }
        const pct = max > 0 ? (total / max) * 100 : 0
        const st  = toStanine(pct)
        results.eq[scale] = { raw: total, max, pct, stanine: st, label: stanineLabel(st), color: stanineColor(st) }
        await saveScore(client, sessionId, studentId, 'eq', scale, total, pct, st)
      }
    }

    // ── 6. MULTIPLE INTELLIGENCES (Gardner) ───────────────────────────────────
    if (byDim.mi) {
      const scales = ['linguistic','logical_math','spatial','musical','kinesthetic','interpersonal','intrapersonal','naturalist']
      results.mi = {}
      for (const scale of scales) {
        const items = byDim.mi.filter(a => a.scale === scale)
        const sum   = items.reduce((acc, a) => acc + (a.response_value || 0), 0)
        const max   = items.length * 3 // Yes=3, Sometimes=2, No=1
        const pct   = max > 0 ? (sum / max) * 100 : 0
        const st    = toStanine(pct)
        results.mi[scale] = { raw: sum, pct, stanine: st, label: stanineLabel(st), color: stanineColor(st) }
        await saveScore(client, sessionId, studentId, 'mi', scale, sum, pct, st)
      }
    }

    // ── 7. WORK VALUES ────────────────────────────────────────────────────────
    if (byDim.values) {
      results.values = {}
      const scales = [...new Set(byDim.values.map(a => a.scale))]
      for (const scale of scales) {
        const items = byDim.values.filter(a => a.scale === scale)
        const sum   = items.reduce((acc, a) => acc + (a.response_value || 0), 0)
        const max   = items.length * 5
        const pct   = max > 0 ? (sum / max) * 100 : 0
        const st    = toStanine(pct)
        results.values[scale] = { raw: sum, pct, stanine: st, label: stanineLabel(st), color: stanineColor(st) }
        await saveScore(client, sessionId, studentId, 'values', scale, sum, pct, st)
      }
    }

    // ── 8. LEARNING STYLE (VAK + Kolb) ───────────────────────────────────────
    if (byDim.learning) {
      results.learning = {}
      const scales = ['visual','auditory','kinesthetic','converger','diverger','assimilator','accommodator']
      for (const scale of scales) {
        const items = byDim.learning.filter(a => a.scale === scale)
        if (!items.length) continue
        const sum = items.reduce((acc, a) => acc + (a.response_value || 0), 0)
        const max = items.length * 5
        const pct = max > 0 ? (sum / max) * 100 : 0
        const st  = toStanine(pct)
        results.learning[scale] = { raw: sum, pct, stanine: st, label: stanineLabel(st) }
        await saveScore(client, sessionId, studentId, 'learning', scale, sum, pct, st)
      }
    }

    // ── CONSISTENCY CHECKS ────────────────────────────────────────────────────
    const flags = detectConsistencyFlags(answers)
    for (const flag of flags) {
      await client.query(
        `INSERT INTO psy_consistency_flags (session_id, student_id, dimension, flag_type, description, severity, question_pair)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [sessionId, studentId, flag.dimension, flag.type, flag.description, flag.severity, flag.pair]
      )
    }
    results.consistencyFlags = flags

    // ── CAREER MATCHING ───────────────────────────────────────────────────────
    const careers = await client.query('SELECT * FROM psy_careers WHERE is_active = true')
    const matches = await matchCareers(careers.rows, results, answers)
    
    // Save top 10 matches
    for (let i = 0; i < Math.min(10, matches.length); i++) {
      const m = matches[i]
      await client.query(
        `INSERT INTO psy_career_matches 
         (session_id, student_id, career_id, rank, composite_fit_pct, riasec_match_pct, 
          aptitude_match_pct, personality_match_pct, mi_match_pct, values_match_pct, dimension_breakdown)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [sessionId, studentId, m.career.id, i+1, m.composite,
         m.riasec, m.aptitude, m.personality, m.mi, m.values,
         JSON.stringify(m.breakdown)]
      )
    }
    results.careerMatches = matches.slice(0, 10)

    await client.query('COMMIT')
    return results

  } catch (err) {
    await client.query('ROLLBACK')
    console.error('Scoring engine error:', err)
    throw err
  } finally {
    client.release()
  }
}

// ── SAVE SCORE HELPER ─────────────────────────────────────────────────────────
async function saveScore(client, sessionId, studentId, dimension, scale, raw, pct, stanine) {
  await client.query(
    `INSERT INTO psy_scores (session_id, student_id, dimension, scale, raw_score, percentage, stanine, stanine_label)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (session_id, dimension, scale) DO UPDATE SET raw_score=$5, percentage=$6, stanine=$7, stanine_label=$8`,
    [sessionId, studentId, dimension, scale, raw, pct, stanine, stanineLabel(stanine)]
  )
}

// ── CONSISTENCY FLAG DETECTION ────────────────────────────────────────────────
function detectConsistencyFlags(answers) {
  const flags = []
  // Check for straight-lining (all same value)
  const dims = [...new Set(answers.map(a => a.dimension))]
  for (const dim of dims) {
    const dimAnswers = answers.filter(a => a.dimension === dim && a.response_value !== null)
    if (dimAnswers.length < 5) continue
    const vals = dimAnswers.map(a => a.response_value)
    const unique = new Set(vals).size
    if (unique === 1) {
      flags.push({ dimension: dim, type: 'pattern_flag', description: `All responses identical (${vals[0]}) — possible disengagement`, severity: 0.8, pair: 'all' })
    }
    // Speed flag — answered too fast (< 2s per question on average)
    const timed = dimAnswers.filter(a => a.time_taken_seconds)
    if (timed.length > 5) {
      const avgTime = timed.reduce((a,b) => a + b.time_taken_seconds, 0) / timed.length
      if (avgTime < 2) {
        flags.push({ dimension: dim, type: 'speed_flag', description: `Average response time ${avgTime.toFixed(1)}s — possibly too fast`, severity: 0.6, pair: 'all' })
      }
    }
  }
  return flags
}

// ── CAREER MATCHING ENGINE ────────────────────────────────────────────────────
async function matchCareers(careers, scores, answers) {
  const results = []

  for (const career of careers) {
    let composite = 0
    const breakdown = {}

    // RIASEC match
    if (scores.orientation && career.riasec_code) {
      const code    = career.riasec_code
      const typeMap = { R:'realistic', I:'investigative', A:'artistic', S:'social', E:'enterprising', C:'conventional' }
      let riasecMatch = 0
      for (let i = 0; i < code.length; i++) {
        const type  = typeMap[code[i]]
        const score = scores.orientation[type]?.pct || 0
        riasecMatch += score * (1 - i * 0.2)  // primary=1x, secondary=0.8x, tertiary=0.6x weight
      }
      riasecMatch = Math.min(100, riasecMatch / 2.4)
      breakdown.riasec = riasecMatch
      composite += riasecMatch * CAREER_WEIGHTS.riasec
    }

    // Aptitude match
    if (scores.aptitude && career.required_aptitudes) {
      const reqApt = typeof career.required_aptitudes === 'string' 
        ? JSON.parse(career.required_aptitudes) : career.required_aptitudes
      const aptScores = reqApt.map(apt => scores.aptitude[apt]?.pct || 0)
      const aptMatch  = aptScores.length > 0 ? aptScores.reduce((a,b) => a+b, 0) / aptScores.length : 50
      breakdown.aptitude = aptMatch
      composite += aptMatch * CAREER_WEIGHTS.aptitude
    }

    // Personality match
    if (scores.personality && career.ideal_personality) {
      const ideal  = typeof career.ideal_personality === 'string'
        ? JSON.parse(career.ideal_personality) : career.ideal_personality
      let personalityMatch = 0, count = 0
      for (const [trait, idealStanine] of Object.entries(ideal)) {
        const actual   = scores.personality[trait]?.stanine || 5
        const diff     = Math.abs(actual - idealStanine)
        personalityMatch += Math.max(0, 100 - (diff * 15))
        count++
      }
      personalityMatch = count > 0 ? personalityMatch / count : 50
      breakdown.personality = personalityMatch
      composite += personalityMatch * CAREER_WEIGHTS.personality
    }

    // MI match
    if (scores.mi && career.ideal_mi) {
      const idealMI = typeof career.ideal_mi === 'string'
        ? JSON.parse(career.ideal_mi) : career.ideal_mi
      const miScores = idealMI.map(mi => scores.mi[mi]?.pct || 0)
      const miMatch  = miScores.length > 0 ? miScores.reduce((a,b) => a+b,0) / miScores.length : 50
      breakdown.mi = miMatch
      composite += miMatch * CAREER_WEIGHTS.mi
    }

    // Values match
    if (scores.values && career.ideal_values) {
      const idealVals = typeof career.ideal_values === 'string'
        ? JSON.parse(career.ideal_values) : career.ideal_values
      const valScores = idealVals.map(v => scores.values[v]?.pct || 0)
      const valMatch  = valScores.length > 0 ? valScores.reduce((a,b) => a+b,0) / valScores.length : 50
      breakdown.values = valMatch
      composite += valMatch * CAREER_WEIGHTS.values
    }

    // Interest match
    if (scores.interest && career.required_interests) {
      const reqInt = typeof career.required_interests === 'string'
        ? JSON.parse(career.required_interests) : career.required_interests
      const intScores = reqInt.map(i => scores.interest[i]?.pct || 0)
      const intMatch  = intScores.length > 0 ? intScores.reduce((a,b) => a+b,0) / intScores.length : 50
      breakdown.interest = intMatch
      composite += intMatch * CAREER_WEIGHTS.interest
    }

    results.push({
      career,
      composite:   Math.round(composite),
      riasec:      Math.round(breakdown.riasec || 0),
      aptitude:    Math.round(breakdown.aptitude || 0),
      personality: Math.round(breakdown.personality || 0),
      mi:          Math.round(breakdown.mi || 0),
      values:      Math.round(breakdown.values || 0),
      breakdown
    })
  }

  return results.sort((a,b) => b.composite - a.composite)
}

// ── GENERATE PARTICIPANT ID ───────────────────────────────────────────────────
function generateParticipantId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let id = 'PSY-'
  for (let i = 0; i < 8; i++) id += chars[Math.floor(Math.random() * chars.length)]
  return id
}

// ── GENERATE PSY ACCESS CODE ──────────────────────────────────────────────────
function generatePsyAccessCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let code = 'PSY-'
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)]
  return code
}

module.exports = { calculateScores, generateParticipantId, generatePsyAccessCode, toStanine, stanineLabel, stanineColor }
