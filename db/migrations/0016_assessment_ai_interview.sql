-- Brick 11: assessment-svc offers AI interview questions (payload {interview_id}); interview-svc
-- scores them and assessment-svc consumes `interview.session.completed.v1` (ADR-0008).
ALTER TYPE question_type ADD VALUE IF NOT EXISTS 'ai_interview';
