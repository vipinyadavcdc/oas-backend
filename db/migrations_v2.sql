-- ============================================
-- CDC EXAM PORTAL v2 — New Migrations
-- Run AFTER schema.sql + migrations.sql
-- ============================================

-- Exam templates table
CREATE TABLE IF NOT EXISTS exam_templates (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  trainer_id UUID REFERENCES trainers(id),
  name VARCHAR(100) NOT NULL,
  config JSONB NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Time-per-question tracking
CREATE TABLE IF NOT EXISTS question_timings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID REFERENCES student_sessions(id) ON DELETE CASCADE,
  question_id UUID REFERENCES questions(id),
  time_spent_seconds INTEGER DEFAULT 0,
  recorded_at TIMESTAMP DEFAULT NOW()
);

-- New columns on exams table
ALTER TABLE exams ADD COLUMN IF NOT EXISTS allow_reattempt BOOLEAN DEFAULT false;
ALTER TABLE exams ADD COLUMN IF NOT EXISTS reattempt_cooldown_hours INTEGER DEFAULT 24;
ALTER TABLE exams ADD COLUMN IF NOT EXISTS template_id UUID REFERENCES exam_templates(id);

-- Question usage tracking
ALTER TABLE questions ADD COLUMN IF NOT EXISTS locked_after_exam UUID;

-- Time tracking on answers
ALTER TABLE student_answers ADD COLUMN IF NOT EXISTS time_spent_seconds INTEGER DEFAULT 0;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_timings_session ON question_timings(session_id);
CREATE INDEX IF NOT EXISTS idx_timings_question ON question_timings(question_id);
CREATE INDEX IF NOT EXISTS idx_templates_trainer ON exam_templates(trainer_id);
CREATE INDEX IF NOT EXISTS idx_exams_status ON exams(status);
CREATE INDEX IF NOT EXISTS idx_exams_room_code ON exams(room_code);
CREATE INDEX IF NOT EXISTS idx_results_exam ON exam_results(exam_id);

-- Unique constraint for answer upsert (if not already added)
ALTER TABLE student_answers DROP CONSTRAINT IF EXISTS uniq_session_question;
ALTER TABLE student_answers ADD CONSTRAINT uniq_session_question UNIQUE (session_id, question_id);
