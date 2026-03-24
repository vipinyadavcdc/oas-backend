-- ============================================
-- CDC EXAM PORTAL - MREI | Full DB Schema
-- ============================================
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- TRAINERS
CREATE TABLE trainers (
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
);

-- QUESTIONS
CREATE TABLE questions (
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
);

-- EXAMS
CREATE TABLE exams (
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
);

-- EXAM QUESTIONS
CREATE TABLE exam_questions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  exam_id UUID REFERENCES exams(id) ON DELETE CASCADE,
  question_id UUID REFERENCES questions(id),
  sequence_order INTEGER NOT NULL,
  marks DECIMAL(4,2) DEFAULT 1.00
);

-- STUDENT SESSIONS
CREATE TABLE student_sessions (
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
);

-- STUDENT ANSWERS
CREATE TABLE student_answers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID REFERENCES student_sessions(id) ON DELETE CASCADE,
  question_id UUID REFERENCES questions(id),
  selected_option CHAR(1),
  is_bookmarked BOOLEAN DEFAULT false,
  answered_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- EXAM RESULTS
CREATE TABLE exam_results (
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
);

-- VIOLATIONS
CREATE TABLE violations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID REFERENCES student_sessions(id) ON DELETE CASCADE,
  violation_type VARCHAR(50) NOT NULL,
  details JSONB,
  occurred_at TIMESTAMP DEFAULT NOW()
);

-- HEARTBEATS
CREATE TABLE heartbeats (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID REFERENCES student_sessions(id) ON DELETE CASCADE,
  pinged_at TIMESTAMP DEFAULT NOW()
);

-- AUDIT LOGS
CREATE TABLE audit_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  trainer_id UUID REFERENCES trainers(id),
  action VARCHAR(100) NOT NULL,
  entity_type VARCHAR(50),
  entity_id UUID,
  details JSONB,
  ip_address INET,
  created_at TIMESTAMP DEFAULT NOW()
);

-- INDEXES
CREATE INDEX idx_sessions_exam ON student_sessions(exam_id);
CREATE INDEX idx_sessions_roll ON student_sessions(roll_number);
CREATE INDEX idx_sessions_token ON student_sessions(session_token);
CREATE INDEX idx_answers_session ON student_answers(session_id);
CREATE INDEX idx_violations_session ON violations(session_id);
CREATE INDEX idx_questions_section ON questions(section);
CREATE INDEX idx_questions_topic ON questions(topic);
CREATE INDEX idx_exam_questions_exam ON exam_questions(exam_id);
CREATE INDEX idx_audit_trainer ON audit_logs(trainer_id);


-- ============================================
-- SEED ADMINS
-- Do NOT use INSERT here. Run this instead:
--   node db/seed.js
-- This uses bcryptjs to hash passwords correctly
-- so they match what the login API expects.
-- ============================================
