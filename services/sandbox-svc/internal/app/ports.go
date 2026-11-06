// Package app holds the use cases: the judge API, the worker loop and event handlers. It
// depends on the domain and on the ports below, never on adapters.
package app

import (
	"atlas.dev/go-platform/events"
	"context"
	"errors"
	"time"

	"atlas.dev/sandbox-svc/internal/domain"
)

// Clock is injected so time-dependent rules are testable.
type Clock interface{ Now() time.Time }

// SystemClock is the real clock.
type SystemClock struct{}

func (SystemClock) Now() time.Time { return time.Now().UTC() }

// Bundle is a question version's registered tests (metadata; cases live in the BlobStore).
type Bundle struct {
	TenantID          string
	QuestionID        string
	Version           int
	ObjectKey         string
	Checksum          [32]byte
	TestCount         int
	SampleCount       int
	Checker           domain.CheckerSpec
	CheckerLanguageID *int
	CheckerSource     *string
	Limits            domain.LimitOverrides
	Languages         []string
	ReferenceLangID   int
	ReferenceSource   string
	Status            string // pending | verified | flaky | reference_failed
	StatusDetail      *string
	VerifiedAt        *time.Time
	CreatedAt         time.Time
}

// Submission is a run, a submission or a reference verification. It is also the queue job.
type Submission struct {
	TenantID        string
	ID              string
	SessionID       *string
	AssessmentID    *string
	CandidateID     *string
	QuestionID      string
	QuestionVersion int
	LanguageID      int
	Mode            string // run | submit | verify
	Lane            domain.Lane
	IdempotencyKey  string
	Source          string
	SourceSHA256    [32]byte
	Stdin           *string
	Status          domain.Verdict
	StatusDetail    *string
	TestsPassed     *int
	TestsTotal      *int
	ScoreRatio      *float64
	MaxCPUms        *int
	MaxMemoryKB     *int
	CompileOutput   *string
	RunStdout       *string
	RunStderr       *string
	WorkerID        *string
	AttemptCount    int
	SimilarityMax   *float64
	SimilarID       *string
	QueuedAt        time.Time
	StartedAt       *time.Time
	FinishedAt      *time.Time
}

// Event is an outbox event (written in the same transaction as the change).
type Event = events.Outgoing

// Completion is the result a worker writes when it finishes a job.
type Completion struct {
	Summary       domain.Summary
	Cases         []domain.CaseResult
	CompileOutput *string
	RunStdout     *string
	RunStderr     *string
	Detail        *string
}

// Fingerprint of a judged submission.
type Fingerprint struct {
	SubmissionID string
	SessionID    string
	Hashes       []int64
}

// TenantRepo works inside one tenant's transaction (RLS bound to the tenant).
type TenantRepo interface {
	GetBundle(ctx context.Context, questionID string, version int) (*Bundle, error)
	// UpsertBundle inserts the bundle, or replaces an unverified one.
	UpsertBundle(ctx context.Context, b Bundle) error
	SetBundleStatus(ctx context.Context, questionID string, version int, status string, detail *string, at time.Time) error

	// InsertSubmission inserts s, or returns the existing row for (tenant, idempotency key).
	InsertSubmission(ctx context.Context, s Submission) (Submission, bool, error)
	GetSubmission(ctx context.Context, id string) (*Submission, error)
	// LockSession serialises run throttling per session for the rest of the transaction.
	LockSession(ctx context.Context, sessionID string) error
	LastRunAt(ctx context.Context, sessionID string) (*time.Time, error)
	// Complete finishes a running job if this worker still holds its lease (false otherwise).
	Complete(ctx context.Context, id, workerID string, c Completion, at time.Time) (bool, error)
	Results(ctx context.Context, id string) ([]domain.CaseResult, error)

	InsertFingerprint(ctx context.Context, assessmentID, questionID string, f Fingerprint) error
	Fingerprints(ctx context.Context, assessmentID, questionID, excludeSession string) ([]Fingerprint, error)
	SetSimilarity(ctx context.Context, id string, similarity float64, otherID string) error

	DeleteCandidate(ctx context.Context, candidateID string) (int, error)
	PurgeTenant(ctx context.Context) ([]string, error) // returns bundle object keys

	AppendOutbox(ctx context.Context, tenantID string, e Event) error
}

// QueueHead is a (lane, tenant) pair that has queued work.
type QueueHead struct {
	Lane     domain.Lane
	TenantID string
}

// ExpiredJob is a job whose lease ran out.
type ExpiredJob struct {
	TenantID string
	ID       string
	Attempts int
}

// SystemRepo works across tenants (queue bookkeeping, registry, event de-duplication).
type SystemRepo interface {
	Languages(ctx context.Context) ([]domain.Language, error)
	QueueHeads(ctx context.Context, languageIDs []int) ([]QueueHead, error)
	// Claim leases the oldest queued job of the tenant in the lane, or returns nil.
	Claim(ctx context.Context, lane domain.Lane, tenantID string, languageIDs []int, workerID string, leaseUntil time.Time) (*Submission, error)
	Heartbeat(ctx context.Context, id, workerID string, leaseUntil time.Time) (bool, error)
	// Release puts a job back in the queue after a sandbox fault (its attempt still counts).
	Release(ctx context.Context, id, workerID string) error
	// Expired returns running jobs whose lease ended before now.
	Expired(ctx context.Context, now time.Time) ([]ExpiredJob, error)
	Requeue(ctx context.Context, id string, now time.Time) (bool, error)
	PurgeRuns(ctx context.Context, before time.Time) (int, error)
	MarkDemand(ctx context.Context, languageIDs []int, at time.Time) error
	// FirstDelivery records (consumer, event); false means it was already processed.
	FirstDelivery(ctx context.Context, consumer, eventID string) (bool, error)
}

// Store opens transactions.
type Store interface {
	InTenant(ctx context.Context, tenantID string, fn func(TenantRepo) error) error
	InSystem(ctx context.Context, fn func(SystemRepo) error) error
	// InSystemThenTenant runs fn in one system transaction that may switch to a tenant context
	// (event consumers: de-duplicate, then act for the event's tenant).
	InSystemThenTenant(ctx context.Context, fn func(SystemRepo, func(tenantID string) (TenantRepo, error)) error) error
	Ping(ctx context.Context) error
}

// BlobStore holds test-case bundles (object storage).
type BlobStore interface {
	Put(ctx context.Context, key string, data []byte) error
	Get(ctx context.Context, key string) ([]byte, error)
	Delete(ctx context.Context, keys []string) error
}

// RunSpec is one process execution inside a box.
type RunSpec struct {
	Argv   []string
	Stdin  string // file name inside the box, or "" for /dev/null
	Stdout string
	Stderr string
	Limits domain.Limits
	Env    map[string]string
}

// Box is one isolated execution environment (isolate box inside a gVisor pod in production).
type Box interface {
	WriteFile(name string, data []byte) error
	// ReadFile reads at most limit bytes; truncated reports whether the file was longer.
	ReadFile(name string, limit int) (data []byte, truncated bool, err error)
	Run(ctx context.Context, spec RunSpec) (domain.Outcome, error)
	// Snapshot saves the box's files (compiled artefacts); Restore puts them into a fresh box.
	Snapshot() (Snapshot, error)
	Restore(s Snapshot) error
	// Reset wipes the box to a fresh state (cleanup + init).
	Reset(ctx context.Context) error
}

// Snapshot is an opaque copy of a box's files.
type Snapshot interface{ Discard() }

// BoxPool hands out warm boxes. Acquire returns a fresh (empty) box; Release resets it.
type BoxPool interface {
	Acquire(ctx context.Context) (Box, error)
	Release(b Box)
}

// ErrNotFound is returned by repositories for missing rows.
var ErrNotFound = errors.New("not found")
