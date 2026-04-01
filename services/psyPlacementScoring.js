// CDC PSYCHOMETRIC — CSE Role Matching Engine
// Runs after both psychometric + placement sections complete

const pool = require('../db/pool')
const { CSE_ROLES_DATA } = require('./psyCseRoles')

// CSE Role definitions (mirror of frontend data)
const CSE_ROLES = [
  { id:'data_science_ml',    riasec:['investigative','artistic'],      bigfive:{openness:8,conscientiousness:7},   aptScales:['logical','abstract'],        miScales:['logical_math','intrapersonal'] },
  { id:'backend_engineering',riasec:['investigative','conventional'],  bigfive:{conscientiousness:8,openness:6},   aptScales:['logical','infotech'],         miScales:['logical_math','spatial'] },
  { id:'frontend_uiux',      riasec:['artistic','investigative'],      bigfive:{openness:9,agreeableness:7},       aptScales:['creative','spatial'],         miScales:['spatial','linguistic'] },
  { id:'fullstack',          riasec:['investigative','realistic'],     bigfive:{conscientiousness:7,openness:7},   aptScales:['logical','infotech','creative'],miScales:['logical_math','spatial'] },
  { id:'cybersecurity',      riasec:['investigative','realistic'],     bigfive:{conscientiousness:9,openness:7},   aptScales:['logical','abstract'],         miScales:['logical_math','intrapersonal'] },
  { id:'devops_cloud',       riasec:['realistic','investigative'],     bigfive:{conscientiousness:9,stability:8},  aptScales:['logical','infotech'],         miScales:['logical_math','spatial'] },
  { id:'product_management', riasec:['enterprising','investigative'],  bigfive:{extraversion:7,openness:8},        aptScales:['verbal','creative'],          miScales:['interpersonal','linguistic'] },
  { id:'entrepreneurship',   riasec:['enterprising','artistic'],      bigfive:{extraversion:8,openness:9},        aptScales:['creative','abstract'],        miScales:['interpersonal','intrapersonal'] },
  { id:'higher_studies',     riasec:['investigative','social'],        bigfive:{openness:9,conscientiousness:8},   aptScales:['abstract','logical'],         miScales:['logical_math','intrapersonal'] },
  { id:'government_psu',     riasec:['conventional','realistic'],     bigfive:{conscientiousness:9,stability:9},  aptScales:['logical','numerical'],        miScales:['logical_math','intrapersonal'] },
  { id:'it_consulting',      riasec:['enterprising','social'],        bigfive:{extraversion:7,agreeableness:7},   aptScales:['verbal','logical'],           miScales:['interpersonal','linguistic'] },
  { id:'family_business',    riasec:['enterprising','conventional'],  bigfive:{conscientiousness:8,agreeableness:8},aptScales:['numerical','logical'],      miScales:['interpersonal','logical_math'] },
]

// Aptitude correct answers for placement questions
const PLACEMENT_CORRECT = {
  WA1:2,WA2:1,WA3:1,WA4:1,WA5:1,WA6:2,WA7:2,
  WA8:0,WA9:1,WA10:0,WA11:2,WA12:1,WA13:1,WA14:1,
  WA15:1,WA16:1,WA17:1,WA18:2,WA19:2,WA20:1,WA21:1,
  CS1:2,CS2:1,CS3:2,CS4:1,CS5:1,CS6:2,CS7:2,CS8:3,CS9:1,
}

// Soft skills weights
const SS_WEIGHTS = {
  SS1:[1,9,0,2],SS2:[3,9,2,0],SS3:[1,9,3,2],SS4:[1,2,9,0],SS5:[0,1,9,5],
  SS6:[2,0,9,1],SS7:[0,9,1,3],SS8:[0,9,3,1],SS9:[2,0,9,4],SS10:[0,9,1,0],
  SS11:[0,9,1,2],SS12:[0,2,9,1],SS13:[0,9,1,2],SS14:[1,9,0,3],SS15:[1,0,9,0],
}

async function calculatePlacementScores(placementSessionId, studentId, answers) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    // ── Profile Score ─────────────────────────────────────────────
    const profileAnswers = answers.filter(a => a.section === 'profile')
    const profileScoreDefs = {
      PR1:[1,2,3,4],PR2:[0,2,3,4],PR3:[0,1,3,4],PR4:[0,1,3,4],PR5:[0,1,2,4],
      PR6:[0,1,3,4],PR7:[0,1,2,4],PR8:[0,1,3,4],PR9:[0,1,2,4],PR10:[0,1,2,4],
    }
    let profileRaw = 0
    for (const a of profileAnswers) {
      const scores = profileScoreDefs[a.question_id]
      if (scores && a.response_value !== null) profileRaw += scores[a.response_value] || 0
    }
    const profilePct = Math.min(100, (profileRaw / 36) * 100)

    // ── Aptitude Score ────────────────────────────────────────────
    const aptAnswers = answers.filter(a => a.section === 'aptitude')
    let reasoningCorrect = 0, reasoningTotal = 0, csCorrect = 0, csTotal = 0
    for (const a of aptAnswers) {
      const correct = PLACEMENT_CORRECT[a.question_id]
      if (correct !== undefined) {
        if (a.question_id.startsWith('WA')) {
          reasoningTotal++
          if (a.response_value === correct) reasoningCorrect++
        } else {
          csTotal++
          if (a.response_value === correct) csCorrect++
        }
      }
    }
    const reasoningPct = reasoningTotal > 0 ? (reasoningCorrect / reasoningTotal) * 100 : 0
    const csPct        = csTotal > 0 ? (csCorrect / csTotal) * 100 : 0
    const aptOverall   = (reasoningPct * 0.7) + (csPct * 0.3)

    // ── Soft Skills Score ─────────────────────────────────────────
    const ssAnswers = answers.filter(a => a.section === 'softskills')
    let ssTotal = 0, ssMax = 0
    for (const a of ssAnswers) {
      const weights = SS_WEIGHTS[a.question_id]
      if (weights && a.response_value !== null) {
        ssTotal += weights[a.response_value] || 0
        ssMax   += 9
      }
    }
    const softSkillsPct = ssMax > 0 ? (ssTotal / ssMax) * 100 : 0

    // ── Career Clarity ────────────────────────────────────────────
    const clarityAnswers = answers.filter(a => a.section === 'clarity')
    const clarityData = {}
    for (const a of clarityAnswers) {
      clarityData[a.question_id] = a.response_value
    }

    // ── Overall Placement Readiness ───────────────────────────────
    const placementReadiness = (profilePct * 0.15) + (aptOverall * 0.40) + (softSkillsPct * 0.30) + 15 // base 15 for showing up

    // Save to placement session
    await client.query(
      `UPDATE psy_placement_sessions SET
       status='completed', completed_at=NOW(),
       profile_score=$1, aptitude_reasoning_pct=$2, aptitude_cs_pct=$3,
       aptitude_overall_pct=$4, soft_skills_pct=$5,
       career_clarity_data=$6, placement_readiness_pct=$7
       WHERE id=$8`,
      [profilePct, reasoningPct, csPct, aptOverall, softSkillsPct,
       JSON.stringify(clarityData), Math.min(100, placementReadiness), placementSessionId]
    )

    // ── CSE Role Matching ─────────────────────────────────────────
    const psychScores = await client.query(
      'SELECT * FROM psy_scores WHERE student_id=$1', [studentId]
    )
    const scoreMap = {}
    for (const s of psychScores.rows) {
      if (!scoreMap[s.dimension]) scoreMap[s.dimension] = {}
      scoreMap[s.dimension][s.scale] = s
    }

    const roleMatches = []
    for (const role of CSE_ROLES) {
      let psychScore = 0, psychWeight = 0

      // RIASEC match (30% of psychometric score)
      const orientation = scoreMap.orientation || {}
      let riasecScore = 0
      for (let i = 0; i < role.riasec.length; i++) {
        const pct = orientation[role.riasec[i]]?.percentage || 0
        riasecScore += pct * (1 - i * 0.3)
      }
      riasecScore = Math.min(100, riasecScore / 1.7)
      psychScore  += riasecScore * 0.30
      psychWeight += 0.30

      // Big Five match (25%)
      const personality = scoreMap.personality || {}
      let bfScore = 0, bfCount = 0
      for (const [trait, idealSt] of Object.entries(role.bigfive)) {
        const actualSt = personality[trait]?.stanine || 5
        const diff = Math.abs(actualSt - idealSt)
        bfScore += Math.max(0, 100 - diff * 15)
        bfCount++
      }
      bfScore = bfCount > 0 ? bfScore / bfCount : 50
      psychScore  += bfScore * 0.25
      psychWeight += 0.25

      // Aptitude match (25%)
      const aptitude = scoreMap.aptitude || {}
      const aptVals  = role.aptScales.map(s => aptitude[s]?.percentage || 50)
      const aptScore = aptVals.reduce((a,b) => a+b, 0) / aptVals.length
      psychScore  += aptScore * 0.25
      psychWeight += 0.25

      // MI match (20%)
      const mi      = scoreMap.mi || {}
      const miVals  = role.miScales.map(s => mi[s]?.percentage || 50)
      const miScore = miVals.reduce((a,b) => a+b, 0) / miVals.length
      psychScore  += miScore * 0.20
      psychWeight += 0.20

      const normalisedPsych = psychWeight > 0 ? psychScore / psychWeight : 50

      // Placement score contribution (clarity signals)
      let clarityBonus = 0
      // Simple: aptitude and soft skills feed directly
      const placementScore = (aptOverall * 0.5) + (softSkillsPct * 0.3) + (profilePct * 0.2)

      // Career clarity signal matching
      const claritySignals = getClaritySignals(role.id)
      let signalMatch = 0, signalCount = 0
      for (const [key, validValues] of Object.entries(claritySignals)) {
        const qMap = { environment:'CC1', priority:'CC2', vision:'CC3', work_type:'CC4', risk_tolerance:'CC5', daily_work:'CC6', role_preference:'CC7', tech_drive:'CC8' }
        const qId  = qMap[key]
        if (qId && clarityData[qId] !== undefined) {
          signalMatch += validValues.includes(clarityData[qId]) ? 100 : 30
          signalCount++
        }
      }
      const clarityScore = signalCount > 0 ? signalMatch / signalCount : 50

      // Final composite: 60% psychometric + 25% placement aptitude + 15% clarity
      const composite = Math.round(
        normalisedPsych * 0.60 +
        placementScore  * 0.25 +
        clarityScore    * 0.15
      )

      roleMatches.push({
        role_id:          role.id,
        composite_match_pct: Math.min(99, composite),
        psychometric_pct: Math.round(normalisedPsych),
        placement_pct:    Math.round(placementScore),
        breakdown:        { riasec: Math.round(riasecScore), bigfive: Math.round(bfScore), aptitude: Math.round(aptScore), mi: Math.round(miScore), clarity: Math.round(clarityScore) }
      })
    }

    roleMatches.sort((a,b) => b.composite_match_pct - a.composite_match_pct)

    // Save top 5 matches
    for (let i = 0; i < Math.min(5, roleMatches.length); i++) {
      const m    = roleMatches[i]
      const role = CSE_ROLES.find(r => r.id === m.role_id)
      await client.query(
        `INSERT INTO psy_cse_role_matches 
         (student_id, session_id, rank, role_id, role_name, composite_match_pct, psychometric_pct, placement_pct, breakdown, is_recommended)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [studentId, (await client.query('SELECT session_id FROM psy_placement_sessions WHERE id=$1', [placementSessionId])).rows[0]?.session_id,
         i+1, m.role_id, getRoleName(m.role_id), m.composite_match_pct, m.psychometric_pct, m.placement_pct, JSON.stringify(m.breakdown), i === 0]
      )
    }

    await client.query('COMMIT')
    return { roleMatches: roleMatches.slice(0,5), placementReadiness: Math.min(100, placementReadiness) }

  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

function getRoleName(roleId) {
  const names = {
    data_science_ml:'Data Science / ML / AI', backend_engineering:'Backend Engineering',
    frontend_uiux:'Frontend / UI-UX Engineering', fullstack:'Full Stack Development',
    cybersecurity:'Cybersecurity / Ethical Hacking', devops_cloud:'DevOps / Cloud Engineering',
    product_management:'Product Management', entrepreneurship:'Entrepreneurship / Startup Founder',
    higher_studies:'Higher Studies (M.Tech / MS / MBA / PhD)',
    government_psu:'Government / PSU (GATE Route)', it_consulting:'IT Consulting / Business Analyst',
    family_business:'Family Business (Tech-enabled)',
  }
  return names[roleId] || roleId
}

function getClaritySignals(roleId) {
  const signals = {
    data_science_ml:    { environment:[0,1], vision:[0,2], work_type:[3], tech_drive:[2,3] },
    backend_engineering:{ daily_work:[0,1], work_type:[1], environment:[0,1] },
    frontend_uiux:      { work_type:[0,3], daily_work:[0], tech_drive:[1,2] },
    fullstack:          { environment:[0,1], work_type:[0,1], daily_work:[0] },
    cybersecurity:      { tech_drive:[2,3], work_type:[1], daily_work:[0,1] },
    devops_cloud:       { daily_work:[0,1], risk_tolerance:[0,1], tech_drive:[2,3] },
    product_management: { vision:[0], work_type:[2,3], daily_work:[2] },
    entrepreneurship:   { vision:[1], environment:[1], risk_tolerance:[2,3], work_type:[3] },
    higher_studies:     { vision:[2], environment:[3], work_type:[3], tech_drive:[2,3] },
    government_psu:     { environment:[2], risk_tolerance:[0,1], priority:[2] },
    it_consulting:      { daily_work:[2], work_type:[2], environment:[0] },
    family_business:    { vision:[3], environment:[1,2], risk_tolerance:[1,3] },
  }
  return signals[roleId] || {}
}

module.exports = { calculatePlacementScores }
