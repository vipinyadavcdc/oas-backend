require('dotenv').config()
const pool = require('./pool')
const bcrypt = require('bcryptjs')

async function seed() {
  // Create extensions
  await pool.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`)
  await pool.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`)
  console.log('Extensions ready')

  // Create all tables
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

  console.log('All tables created')

  // Seed admins
  const admins = [
    { emp_id: 'EMP001', name: 'Vipin',   email: 'vipin@mrei.ac.in',   role: 'super_admin' },
    { emp_id: 'EMP002', name: 'Ankur',   email: 'ankur@mrei.ac.in',   role: 'super_admin' },
    { emp_id: 'EMP003', name: 'Kirti',   email: 'kirti@mrei.ac.in',   role: 'super_admin' },
    { emp_id: 'EMP004', name: 'Harmeet', email: 'harmeet@mrei.ac.in', role: 'super_admin' },
  ]

  for (const admin of admins) {
    const hash = await bcrypt.hash(admin.emp_id, 12)
    await pool.query(
      `INSERT INTO trainers (emp_id, name, email, password_hash, role)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (emp_id) DO UPDATE SET password_hash = $4, role = $5, is_active = true`,
      [admin.emp_id, admin.name, admin.email, hash, admin.role]
    )
    console.log('Seeded: ' + admin.emp_id + ' (' + admin.name + ')')
  }

  console.log('All admins seeded. Default password = emp_id')
  process.exit(0)
}

seed().catch(err => { console.error('Seed failed:', err); process.exit(1) })
