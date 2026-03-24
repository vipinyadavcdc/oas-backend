require('dotenv').config()
const pool = require('./pool')
const bcrypt = require('bcryptjs')

async function seed() {
  console.log('Setting up database...')

  await pool.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`)
  await pool.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`)

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
    ALTER TABLE student_answers ADD CONSTRAINT IF NOT EXISTS uniq_sess_q UNIQUE (session_id, question_id)
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

  // Indexes
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_sessions_exam ON student_sessions(exam_id)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_sessions_roll ON student_sessions(roll_number)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_sessions_token ON student_sessions(session_token)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_answers_session ON student_answers(session_id)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_violations_session ON violations(session_id)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_questions_section ON questions(section)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_exam_questions_exam ON exam_questions(exam_id)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_sessions_roll_exam ON student_sessions(roll_number, exam_id)`)

  console.log('All tables created')

  // 24 trainers — 4 super admins + 20 trainers
  // Password for everyone = their emp_id (e.g. EMP001)
  const trainers = [
    // Super Admins
    { emp_id: 'EMP001', name: 'Vipin Yadav',      email: 'vipin@mrei.ac.in',      role: 'super_admin', department: 'CDC' },
    { emp_id: 'EMP002', name: 'Ankur Sharma',     email: 'ankur@mrei.ac.in',      role: 'super_admin', department: 'CDC' },
    { emp_id: 'EMP003', name: 'Kirti Gupta',      email: 'kirti@mrei.ac.in',      role: 'super_admin', department: 'CDC' },
    { emp_id: 'EMP004', name: 'Harmeet Singh',    email: 'harmeet@mrei.ac.in',    role: 'super_admin', department: 'CDC' },
    // Trainers
    { emp_id: 'EMP005', name: 'Rahul Verma',      email: 'rahul.v@mrei.ac.in',    role: 'trainer', department: 'CSE' },
    { emp_id: 'EMP006', name: 'Priya Mehta',      email: 'priya.m@mrei.ac.in',    role: 'trainer', department: 'CSE' },
    { emp_id: 'EMP007', name: 'Amit Kumar',       email: 'amit.k@mrei.ac.in',     role: 'trainer', department: 'ECE' },
    { emp_id: 'EMP008', name: 'Sneha Patel',      email: 'sneha.p@mrei.ac.in',    role: 'trainer', department: 'ECE' },
    { emp_id: 'EMP009', name: 'Rohan Gupta',      email: 'rohan.g@mrei.ac.in',    role: 'trainer', department: 'ME' },
    { emp_id: 'EMP010', name: 'Neha Singh',       email: 'neha.s@mrei.ac.in',     role: 'trainer', department: 'ME' },
    { emp_id: 'EMP011', name: 'Vikash Yadav',     email: 'vikash.y@mrei.ac.in',   role: 'trainer', department: 'CE' },
    { emp_id: 'EMP012', name: 'Pooja Sharma',     email: 'pooja.s@mrei.ac.in',    role: 'trainer', department: 'CE' },
    { emp_id: 'EMP013', name: 'Deepak Raj',       email: 'deepak.r@mrei.ac.in',   role: 'trainer', department: 'IT' },
    { emp_id: 'EMP014', name: 'Kavita Mishra',    email: 'kavita.m@mrei.ac.in',   role: 'trainer', department: 'IT' },
    { emp_id: 'EMP015', name: 'Sanjay Tiwari',    email: 'sanjay.t@mrei.ac.in',   role: 'trainer', department: 'MBA' },
    { emp_id: 'EMP016', name: 'Ritu Agarwal',     email: 'ritu.a@mrei.ac.in',     role: 'trainer', department: 'MBA' },
    { emp_id: 'EMP017', name: 'Manish Dubey',     email: 'manish.d@mrei.ac.in',   role: 'trainer', department: 'BCA' },
    { emp_id: 'EMP018', name: 'Sunita Joshi',     email: 'sunita.j@mrei.ac.in',   role: 'trainer', department: 'BCA' },
    { emp_id: 'EMP019', name: 'Ajay Pandey',      email: 'ajay.p@mrei.ac.in',     role: 'trainer', department: 'MCA' },
    { emp_id: 'EMP020', name: 'Renu Chauhan',     email: 'renu.c@mrei.ac.in',     role: 'trainer', department: 'MCA' },
    { emp_id: 'EMP021', name: 'Suresh Pal',       email: 'suresh.p@mrei.ac.in',   role: 'trainer', department: 'EEE' },
    { emp_id: 'EMP022', name: 'Meena Rawat',      email: 'meena.r@mrei.ac.in',    role: 'trainer', department: 'EEE' },
    { emp_id: 'EMP023', name: 'Pankaj Saxena',    email: 'pankaj.s@mrei.ac.in',   role: 'trainer', department: 'BIOTECH' },
    { emp_id: 'EMP024', name: 'Alka Srivastava',  email: 'alka.s@mrei.ac.in',     role: 'trainer', department: 'BIOTECH' },
  ]

  for (const t of trainers) {
    const hash = await bcrypt.hash(t.emp_id, 12)
    await pool.query(
      `INSERT INTO trainers (emp_id, name, email, password_hash, role, department)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (emp_id) DO UPDATE SET
         password_hash = $4, role = $5, department = $6, is_active = true`,
      [t.emp_id, t.name, t.email, hash, t.role, t.department]
    )
    console.log('Seeded: ' + t.emp_id + ' | ' + t.name + ' | ' + t.email + ' | ' + t.role)
  }

  console.log('')
  console.log('Done! 24 users seeded.')
  console.log('Login with emp_id (e.g. EMP001) OR email (e.g. vipin@mrei.ac.in)')
  console.log('Password = emp_id (e.g. EMP001)')
  process.exit(0)
}

seed().catch(err => { console.error('Seed failed:', err); process.exit(1) })
