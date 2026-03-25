require('dotenv').config()
const pool = require('./pool')
const bcrypt = require('bcryptjs')

async function seed() {
  console.log('Running safe migration...')

  await pool.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`)
  await pool.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`)

  // Create tables only if they don't exist - NEVER DROP
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trainers (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      emp_id VARCHAR(20) UNIQUE NOT NULL,
      name VARCHAR(100) NOT NULL,
      email VARCHAR(100) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role VARCHAR(20) NOT NULL DEFAULT 'trainer',
      university VARCHAR(20) DEFAULT 'BOTH',
      department VARCHAR(100),
      mobile VARCHAR(15),
      designation VARCHAR(100),
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW(),
      last_login TIMESTAMP
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS questions (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      trainer_id UUID REFERENCES trainers(id),
      section VARCHAR(50) NOT NULL,
      topic VARCHAR(100) NOT NULL,
      tag VARCHAR(20),
      question_text TEXT NOT NULL,
      option_a TEXT NOT NULL,
      option_b TEXT NOT NULL,
      option_c TEXT NOT NULL,
      option_d TEXT NOT NULL,
      correct_option CHAR(1) NOT NULL,
      explanation TEXT,
      difficulty VARCHAR(20) DEFAULT 'medium',
      image_url TEXT,
      is_active BOOLEAN DEFAULT true,
      is_archived BOOLEAN DEFAULT false,
      is_locked BOOLEAN DEFAULT false,
      usage_count INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS exams (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      trainer_id UUID REFERENCES trainers(id),
      title VARCHAR(200) NOT NULL,
      description TEXT,
      exam_type VARCHAR(30) NOT NULL,
      university VARCHAR(20) NOT NULL,
      department VARCHAR(100),
      section_filter VARCHAR(50),
      duration_minutes INTEGER NOT NULL DEFAULT 60,
      start_time TIMESTAMP,
      end_time TIMESTAMP,
      room_code VARCHAR(10) NOT NULL,
      marks_per_question DECIMAL(4,2) DEFAULT 1.00,
      negative_marking BOOLEAN DEFAULT false,
      negative_marks DECIMAL(4,2) DEFAULT 0.25,
      total_questions INTEGER DEFAULT 0,
      aptitude_count INTEGER DEFAULT 0,
      verbal_count INTEGER DEFAULT 0,
      randomize_questions BOOLEAN DEFAULT true,
      randomize_options BOOLEAN DEFAULT true,
      status VARCHAR(20) DEFAULT 'draft',
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS exam_questions (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      exam_id UUID REFERENCES exams(id) ON DELETE CASCADE,
      question_id UUID REFERENCES questions(id),
      sequence_order INTEGER NOT NULL,
      marks DECIMAL(4,2) DEFAULT 1.00
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS student_sessions (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      exam_id UUID REFERENCES exams(id),
      name VARCHAR(100) NOT NULL,
      roll_number VARCHAR(50) NOT NULL,
      mobile VARCHAR(15) NOT NULL,
      email VARCHAR(100) NOT NULL,
      university VARCHAR(20) NOT NULL,
      department VARCHAR(100) NOT NULL,
      section VARCHAR(20) NOT NULL,
      session_token UUID UNIQUE DEFAULT uuid_generate_v4(),
      ip_address INET,
      geolocation JSONB,
      user_agent TEXT,
      question_order JSONB,
      option_orders JSONB,
      started_at TIMESTAMP DEFAULT NOW(),
      submitted_at TIMESTAMP,
      time_taken_seconds INTEGER,
      status VARCHAR(20) DEFAULT 'active',
      is_flagged BOOLEAN DEFAULT false
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS student_answers (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      session_id UUID REFERENCES student_sessions(id) ON DELETE CASCADE,
      question_id UUID REFERENCES questions(id),
      selected_option CHAR(1),
      is_bookmarked BOOLEAN DEFAULT false,
      time_spent_seconds INTEGER DEFAULT 0,
      answered_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS exam_results (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      session_id UUID UNIQUE REFERENCES student_sessions(id),
      exam_id UUID REFERENCES exams(id),
      total_questions INTEGER,
      attempted INTEGER DEFAULT 0,
      correct INTEGER DEFAULT 0,
      incorrect INTEGER DEFAULT 0,
      skipped INTEGER DEFAULT 0,
      raw_score DECIMAL(8,2) DEFAULT 0,
      final_score DECIMAL(8,2) DEFAULT 0,
      max_score DECIMAL(8,2) DEFAULT 0,
      percentage DECIMAL(5,2) DEFAULT 0,
      aptitude_score DECIMAL(8,2) DEFAULT 0,
      verbal_score DECIMAL(8,2) DEFAULT 0,
      calculated_at TIMESTAMP DEFAULT NOW()
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS violations (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      session_id UUID REFERENCES student_sessions(id) ON DELETE CASCADE,
      violation_type VARCHAR(50) NOT NULL,
      details JSONB,
      occurred_at TIMESTAMP DEFAULT NOW()
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS heartbeats (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      session_id UUID REFERENCES student_sessions(id) ON DELETE CASCADE,
      pinged_at TIMESTAMP DEFAULT NOW()
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      trainer_id UUID REFERENCES trainers(id),
      action VARCHAR(100) NOT NULL,
      entity_type VARCHAR(50),
      entity_id UUID,
      details JSONB,
      ip_address INET,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS exam_templates (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      trainer_id UUID REFERENCES trainers(id),
      name VARCHAR(200) NOT NULL,
      exam_type VARCHAR(30) NOT NULL,
      university VARCHAR(20) DEFAULT 'BOTH',
      department VARCHAR(100),
      duration_minutes INTEGER NOT NULL DEFAULT 60,
      marks_per_question DECIMAL(4,2) DEFAULT 1.00,
      negative_marking BOOLEAN DEFAULT false,
      negative_marks DECIMAL(4,2) DEFAULT 0.25,
      aptitude_count INTEGER DEFAULT 15,
      verbal_count INTEGER DEFAULT 10,
      randomize_questions BOOLEAN DEFAULT true,
      randomize_options BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `)

  // Safe migrations - ADD COLUMN IF NOT EXISTS never destroys data
  await pool.query(`ALTER TABLE trainers ADD COLUMN IF NOT EXISTS mobile VARCHAR(15)`)
  await pool.query(`ALTER TABLE trainers ADD COLUMN IF NOT EXISTS designation VARCHAR(100)`)
  await pool.query(`ALTER TABLE questions ADD COLUMN IF NOT EXISTS tag VARCHAR(20)`)
  await pool.query(`ALTER TABLE exams ADD COLUMN IF NOT EXISTS aptitude_time_minutes INTEGER DEFAULT 0`)
  await pool.query(`ALTER TABLE exams ADD COLUMN IF NOT EXISTS verbal_time_minutes INTEGER DEFAULT 0`)
  await pool.query(`ALTER TABLE exams ADD COLUMN IF NOT EXISTS device_allowed VARCHAR(20) DEFAULT 'both'`)
  await pool.query(`ALTER TABLE student_sessions ADD COLUMN IF NOT EXISTS current_section VARCHAR(20) DEFAULT NULL`)
  await pool.query(`ALTER TABLE student_sessions ADD COLUMN IF NOT EXISTS section_order JSONB DEFAULT NULL`)
  await pool.query(`ALTER TABLE student_sessions ADD COLUMN IF NOT EXISTS aptitude_started_at TIMESTAMP DEFAULT NULL`)
  await pool.query(`ALTER TABLE student_sessions ADD COLUMN IF NOT EXISTS aptitude_submitted_at TIMESTAMP DEFAULT NULL`)
  await pool.query(`ALTER TABLE student_sessions ADD COLUMN IF NOT EXISTS verbal_started_at TIMESTAMP DEFAULT NULL`)
  await pool.query(`ALTER TABLE student_sessions ADD COLUMN IF NOT EXISTS verbal_submitted_at TIMESTAMP DEFAULT NULL`)
  await pool.query(`ALTER TABLE student_sessions ADD COLUMN IF NOT EXISTS aptitude_time_used INTEGER DEFAULT 0`)
  await pool.query(`ALTER TABLE student_sessions ADD COLUMN IF NOT EXISTS verbal_time_used INTEGER DEFAULT 0`)

  try { await pool.query(`ALTER TABLE student_answers ADD CONSTRAINT uniq_sess_q UNIQUE (session_id, question_id)`) } catch {}

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_sessions_exam ON student_sessions(exam_id)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_sessions_roll ON student_sessions(roll_number)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_sessions_token ON student_sessions(session_token)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_answers_session ON student_answers(session_id)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_violations_session ON violations(session_id)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_questions_section ON questions(section)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_exam_questions_exam ON exam_questions(exam_id)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_sessions_roll_exam ON student_sessions(roll_number, exam_id)`)

  console.log('Migration complete - all columns added safely')

  // Upsert team members - ON CONFLICT means existing users are NOT overwritten
  const team = [
    { emp_id: '4500466', name: 'Vipin Yadav',          email: 'vipinyadav.cdc@mriu.edu.in',      role: 'master_admin', designation: 'Manager',                         mobile: '7508009698' },
    { emp_id: '2010830', name: 'Ankur Kumar Aggarwal', email: 'ankurkumaraggarwal@mru.edu.in',   role: 'master_admin', designation: 'Associate Head-Career Skills',     mobile: '9911888492' },
    { emp_id: '5000706', name: 'Kirti Aggarwal',       email: 'kirtiaggarwal.set@mriu.edu.in',   role: 'super_admin',  designation: 'Manager- Career Skills',           mobile: '9899174007' },
    { emp_id: '5700051', name: 'Harmeet Kaur',         email: 'harmeetkaur.sca@mriu.edu.in',     role: 'super_admin',  designation: 'Lead Technical- Career Skills',    mobile: '9928110309' },
    { emp_id: '4500478', name: 'Divya Bahl',           email: 'divyabahl.cdc@mriu.edu.in',       role: 'trainer',      designation: 'Coordinator',                      mobile: '7503366363' },
    { emp_id: '4500538', name: 'Susanta Bose',         email: 'susantabose.cdc@mriu.edu.in',     role: 'trainer',      designation: 'Head Career Skills',               mobile: '9953315901' },
    { emp_id: '4500462', name: 'Prema Anand',          email: 'premaanand.cdc@mriu.edu.in',      role: 'trainer',      designation: 'Manager Trainee',                  mobile: '9811758154' },
    { emp_id: '4500592', name: 'Shivangee Arora',      email: 'shivangeearora.cdc@mriu.edu.in',  role: 'trainer',      designation: 'Assistant Manager',                mobile: '8826911903' },
    { emp_id: '4500495', name: 'Pranamika Verma',      email: 'pranamika.cdc@mriu.edu.in',       role: 'trainer',      designation: 'Manager -Career Skills',           mobile: '9811668432' },
    { emp_id: '4500618', name: 'Prakash Chandra Jha',  email: 'prakashjha.cdc@mrvpl.in',         role: 'trainer',      designation: 'Deputy Manager-Career Skills',     mobile: '6239982945' },
    { emp_id: '4500506', name: 'Sahil Nagpal',         email: 'sahilnagpal.cdc@mriu.edu.in',     role: 'trainer',      designation: 'Manager',                          mobile: '9953931475' },
    { emp_id: '4500544', name: 'Priya Singh',          email: 'priyasingh.cdc@mriu.edu.in',      role: 'trainer',      designation: 'Asst. Manager',                    mobile: '9873030796' },
    { emp_id: '2010794', name: 'Swapnil Vinod',        email: 'swapnilvinod@mru.edu.in',         role: 'trainer',      designation: 'Sr. Manager Career Skills',        mobile: '9910043046' },
    { emp_id: '8500234', name: 'Snigdha',              email: 'snigdha.cdc@mrvpl.in',            role: 'trainer',      designation: 'Manager',                          mobile: '9873387116' },
    { emp_id: '4500468', name: 'Dr. Monika Aggarwal',  email: 'monikaaggarwal.cdc@mriu.edu.in',  role: 'trainer',      designation: 'Deputy General Manager',           mobile: '9873634445' },
    { emp_id: '8500679', name: 'Geetika',              email: 'geetika.cdc@mrvpl.in',            role: 'trainer',      designation: 'Assistant Manager-Career Skills',  mobile: '9053171150' },
    { emp_id: '4500649', name: 'Karan Sardana',        email: 'karansardana.cdc@mriu.edu.in',    role: 'trainer',      designation: 'Sr. Manager -Career Skills',       mobile: '7838673733' },
    { emp_id: '4500651', name: 'Avik Chakraborty',     email: 'avikchakraborty.cdc@mriu.edu.in', role: 'trainer',      designation: 'Senior Manager',                   mobile: '9880036081' },
    { emp_id: '4500656', name: 'Amjad Chaudhary',      email: 'amjadchaudhary.cdc@mriu.edu.in',  role: 'trainer',      designation: 'Deputy Manager',                   mobile: '8427036871' },
  ]

  for (const t of team) {
    const hash = await bcrypt.hash(t.emp_id, 12)
    await pool.query(
      `INSERT INTO trainers (emp_id, name, email, password_hash, role, mobile, designation)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (emp_id) DO UPDATE SET
         name=$2, email=$3, role=$5, mobile=$6, designation=$7, is_active=true`,
      [t.emp_id, t.name, t.email, hash, t.role, t.mobile, t.designation]
    )
    console.log('Upserted: ' + t.emp_id + ' | ' + t.name)
  }

  console.log('Done! Safe migration complete. Data preserved.')
  process.exit(0)
}

seed().catch(err => { console.error('Seed failed:', err); process.exit(1) })
