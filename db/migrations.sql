-- ============================================================
-- CDC Exam Portal v2 — Migrations
-- Run AFTER schema.sql
-- ============================================================

-- Unique constraint for student_answers (needed for ON CONFLICT)
ALTER TABLE student_answers ADD CONSTRAINT IF NOT EXISTS uniq_sess_q UNIQUE (session_id, question_id);

-- Question usage lock
ALTER TABLE questions ADD COLUMN IF NOT EXISTS is_locked BOOLEAN DEFAULT false;

-- Time-per-question tracking
ALTER TABLE student_answers ADD COLUMN IF NOT EXISTS time_spent_seconds INTEGER DEFAULT 0;

-- Exam templates
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
);

-- Index for student history lookup
CREATE INDEX IF NOT EXISTS idx_sessions_roll_exam ON student_sessions(roll_number, exam_id);
