// Package app holds proctoring-svc's use cases: start, ingest, uploads, inference results, the
// finaliser, reviews, accommodations, event handlers and maintenance. It depends on the domain and
// on the ports below, never on adapters.
package app

import (
	"context"
	"errors"
	"time"

	"atlas.dev/go-platform/events"

	"atlas.dev/proctoring-svc/internal/domain"
)

// Clock is injected so time-dependent rules are testable.
type Clock interface{ Now() time.Time }

// SystemClock is the real clock.
type SystemClock struct{}

func (SystemClock) Now() time.Time { return time.Now().UTC() }

// KeyEntry is one HMAC key epoch (encrypted at rest).
type KeyEntry struct {
	Epoch    int       `json:"epoch"`
	Key      string    `json:"key"` // base64 of the encrypted key
	IssuedAt time.Time `json:"issued_at"`
}

// Notice is something the candidate's client is told on its next batch (warnings, termination).
type Notice struct {
	Rule     string `json:"rule"`
	Severity int    `json:"severity"`
	Action   string `json:"action"`
}

// SessionState is the session's mutable rules state (stored as JSON).
type SessionState struct {
	Engine     domain.State      `json:"engine"`
	Clock      domain.ClockState `json:"clock"`
	Notices    []Notice          `json:"notices,omitempty"`
	NetworkGap bool              `json:"network_gap,omitempty"`
	References int               `json:"references,omitempty"` // reference embeddings stored
	// StreakFrames are the frames of each image flag's current streak: when the streak becomes a
	// violation, all of them are evidence, not only the last.
	StreakFrames map[string][]string `json:"streak_frames,omitempty"`
}

// Session is a proctored assessment session.
type Session struct {
	TenantID        string
	ID              string
	AssessmentID    string
	CandidateID     string
	Status          string // active | finalized
	TokenHash       []byte
	KeyRing         []KeyEntry
	CurrentEpoch    int
	Rules           domain.Rules
	DisabledRules   []string
	Consent         map[string]any
	IDVerification  bool
	References      []byte // encrypted reference embeddings (nil once deleted)
	ReferenceStatus string
	LastSeq         int64
	LastClientHash  string
	LastLogHash     []byte
	State           SessionState
	TrustScore      *int
	Band            *string
	Revision        int
	StartedAt       time.Time
	LastEventAt     *time.Time
	SubmittedAt     *time.Time
	FinalizedAt     *time.Time
	FramesPurgedAt  *time.Time
	LockVersion     int
}

// LogRow is one row of the append-only, hash-chained log.
type LogRow struct {
	LogID        int64
	SessionID    string
	Source       string // client_event | frame_inference | audio_inference | rules | server | review
	Seq          *int64
	EventType    string
	Severity     int
	OccurredAt   time.Time
	ReceivedAt   time.Time
	FrameID      *string
	ModelVersion *string
	Payload      map[string]any
	PrevHash     []byte
	EventHash    []byte
}

// Frame is an uploaded image or audio window.
type Frame struct {
	TenantID    string
	ID          string
	SessionID   string
	Kind        string // frame | selfie | id_document | audio
	ObjectKey   string
	CapturedAt  time.Time
	Triggered   bool
	Status      string // awaiting | uploaded | analysed
	Flagged     bool
	EvidenceKey *string
	DeletedAt   *time.Time
}

// Review is a human decision on a flag.
type Review struct {
	LogID     int64
	SessionID string
	Rule      string
	Decision  string
	Reviewer  string
	Comment   *string
	DecidedAt time.Time
}

// Accommodation disables named rules for one session (with an audit trail).
type Accommodation struct {
	SessionID     string
	DisabledRules []string
	Reason        string
	GrantedBy     string
	GrantedAt     time.Time
}

// TenantRepo works inside one tenant's transaction (RLS bound to the tenant).
type TenantRepo interface {
	GetSession(ctx context.Context, id string, forUpdate bool) (*Session, error)
	InsertSession(ctx context.Context, s *Session) error
	// SaveSession writes the mutable fields (compare-and-set on lock_version, then bumps it).
	SaveSession(ctx context.Context, s *Session) error
	// ClaimSeq records a client sequence number; false when it was already ingested.
	ClaimSeq(ctx context.Context, sessionID string, seq int64) (bool, error)
	// AppendLog chains the row onto the session's last log hash and inserts it.
	AppendLog(ctx context.Context, s *Session, row *LogRow) error
	GetLog(ctx context.Context, logID int64) (*LogRow, error)
	Logs(ctx context.Context, sessionID string, limit int) ([]LogRow, error)

	InsertFrame(ctx context.Context, f Frame) error
	GetFrame(ctx context.Context, id string) (*Frame, error)
	SaveFrame(ctx context.Context, f Frame) error
	Frames(ctx context.Context, sessionID string) ([]Frame, error)
	CountFrames(ctx context.Context, sessionID string) (int, error)

	InsertReview(ctx context.Context, r Review) (bool, error)
	Reviews(ctx context.Context, sessionID string) ([]Review, error)

	GetAccommodation(ctx context.Context, sessionID string) (*Accommodation, error)
	UpsertAccommodation(ctx context.Context, a Accommodation) error

	SessionsOfCandidate(ctx context.Context, candidateID string) ([]string, error)
	AllSessions(ctx context.Context) ([]string, error)
	// EraseSessions deletes every row of the sessions (logs through the definer function).
	EraseSessions(ctx context.Context, ids []string) error

	AppendOutbox(ctx context.Context, e events.Outgoing) error
}

// SystemRepo works across tenants.
type SystemRepo interface {
	SessionByToken(ctx context.Context, sessionID string, tokenHash []byte) (tenantID string, err error)
	FirstDelivery(ctx context.Context, consumer, eventID string) (bool, error)
	// RetentionDue lists finalized sessions whose frames have not been purged yet.
	RetentionDue(ctx context.Context, limit int) ([]Session, error)
	// Silent lists active sessions with no event since before.
	Silent(ctx context.Context, before time.Time, limit int) ([]Session, error)
	EvidencePending(ctx context.Context, limit int) ([]Session, error)
	EnsurePartitions(ctx context.Context, monthsAhead int) (int, error)
	DropPartitions(ctx context.Context, before time.Time) ([]string, error)
}

// Store opens transactions.
type Store interface {
	InTenant(ctx context.Context, tenantID string, fn func(TenantRepo) error) error
	InSystem(ctx context.Context, fn func(SystemRepo) error) error
	InSystemThenTenant(ctx context.Context, fn func(SystemRepo, func(string) (TenantRepo, error)) error) error
	Ping(ctx context.Context) error
}

// Upload is a presigned POST (the policy caps size and content type).
type Upload struct {
	URL       string            `json:"url"`
	Fields    map[string]string `json:"fields"`
	ExpiresAt time.Time         `json:"expires_at"`
}

// BlobStore is object storage for frames and evidence.
type BlobStore interface {
	PresignUpload(ctx context.Context, key, contentType string, maxBytes int64, ttl time.Duration) (Upload, error)
	PresignGet(ctx context.Context, key string, ttl time.Duration) (string, error)
	Copy(ctx context.Context, src, dst string) error
	Delete(ctx context.Context, keys []string) error
	DeletePrefix(ctx context.Context, prefix string) error
}

// Cipher encrypts session keys and biometric references (AES-256-GCM in production).
type Cipher interface {
	Seal(plain []byte, aad string) ([]byte, error)
	Open(sealed []byte, aad string) ([]byte, error)
}

// Retention returns a tenant's frame retention in days (tenant-svc settings, cached).
type Retention interface {
	FrameDays(ctx context.Context, tenantID string) (int, error)
	Invalidate(tenantID string)
}

// ErrNotFound is returned by repositories for missing rows.
var ErrNotFound = errors.New("not found")

// ErrConflict is returned when a compare-and-set lost.
var ErrConflict = errors.New("concurrent update")
