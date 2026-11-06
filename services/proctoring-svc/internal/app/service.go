package app

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"strings"
	"time"

	"atlas.dev/go-platform/auth"
	"atlas.dev/go-platform/events"
	"atlas.dev/go-platform/pgtx"

	"atlas.dev/proctoring-svc/internal/domain"
)

// Scopes and roles.
const (
	ScopeSessions  = "proctoring:sessions"  // assessment-svc starts proctoring
	ScopeInference = "proctoring:inference" // cv-inference posts results
)

// Roles that may read timelines and decide flags.
var (
	ReaderRoles   = []string{"tenant_admin", "recruiter", "hiring_manager", "reviewer"}
	ReviewerRoles = []string{"tenant_admin", "recruiter", "reviewer"}
	GrantorRoles  = []string{"tenant_admin", "recruiter"}
)

// Topics.
const (
	TopicViolation     = "proctoring.violation.raised.v1"
	TopicFinalized     = "proctoring.session.finalized.v1"
	TopicFrameUploaded = "proctoring.frame.uploaded.v1"
	TopicErasureAck    = "privacy.erasure.acknowledged.v1"
)

// Limits.
const (
	KeyRotation   = 15 * time.Minute
	MaxBatch      = 200
	MaxFrames     = 2000 // per session (a 4 h test at 20 s cadence plus triggers)
	MaxReferences = 3
	ImageMaxBytes = 512 << 10
	AudioMaxBytes = 2 << 20
	UploadTTL     = 15 * time.Minute
	SignedURLTTL  = 15 * time.Minute
	EmbeddingDims = 512
)

// Service implements the use cases.
type Service struct {
	Store     Store
	Blobs     BlobStore
	Cipher    Cipher
	Retention Retention
	Clock     Clock
	Log       *slog.Logger
	NewID     func() string
}

func fail(kind, code, format string, args ...any) error {
	return domain.Fail(kind, code, fmt.Sprintf(format, args...))
}

// --- Start ---------------------------------------------------------------------------------------

// StartInput comes from assessment-svc (which checked the candidate's session and consent).
type StartInput struct {
	AssessmentID   string
	CandidateID    string
	Rules          *domain.Rules
	Consent        map[string]any
	IDVerification bool
}

// StartResult is returned to the candidate's client through assessment-svc.
type StartResult struct {
	ProctorToken       string       `json:"proctor_token"`
	SessionKey         string       `json:"session_key"`
	KeyEpoch           int          `json:"key_epoch"`
	NextSeq            int64        `json:"next_seq"`
	PrevHash           string       `json:"prev_hash"`
	Rules              domain.Rules `json:"rules"`
	DisabledRules      []string     `json:"disabled_rules"`
	ReferencesRequired []string     `json:"references_required"`
	ServerTime         time.Time    `json:"server_time"`
}

func randomBytes(n int) []byte {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return b
}

func (s *Service) newKey(sessionID string, epoch int, now time.Time) (KeyEntry, []byte, error) {
	key := randomBytes(32)
	sealed, err := s.Cipher.Seal(key, fmt.Sprintf("hmac:%s:%d", sessionID, epoch))
	if err != nil {
		return KeyEntry{}, nil, err
	}
	return KeyEntry{Epoch: epoch, Key: base64.StdEncoding.EncodeToString(sealed), IssuedAt: now}, key, nil
}

func (s *Service) key(sess *Session, epoch int) ([]byte, bool) {
	for _, k := range sess.KeyRing {
		if k.Epoch == epoch {
			sealed, err := base64.StdEncoding.DecodeString(k.Key)
			if err != nil {
				return nil, false
			}
			key, err := s.Cipher.Open(sealed, fmt.Sprintf("hmac:%s:%d", sess.ID, epoch))
			return key, err == nil
		}
	}
	return nil, false
}

// Start begins (or, after a page reload, resumes) proctoring for a session.
func (s *Service) Start(ctx context.Context, p auth.Principal, tenant, sessionID string, in StartInput) (StartResult, error) {
	if !p.IsService(ScopeSessions) {
		return StartResult{}, fail("forbidden", "FORBIDDEN", "This operation needs the %s scope.", ScopeSessions)
	}
	rules := domain.DefaultRules()
	if in.Rules != nil {
		rules = *in.Rules
	}
	if err := rules.Validate(); err != nil {
		return StartResult{}, err
	}
	if rules.UsesCamera() && in.Consent["biometrics"] != true {
		return StartResult{}, fail("rule", "CONSENT_REQUIRED", "Webcam proctoring needs the candidate's explicit biometric consent.")
	}
	now := s.Clock.Now()
	token := "apt_" + base64.RawURLEncoding.EncodeToString(randomBytes(32))
	hash := sha256.Sum256([]byte(token))
	var res StartResult
	err := s.Store.InTenant(ctx, tenant, func(r TenantRepo) error {
		sess, err := r.GetSession(ctx, sessionID, true)
		if err != nil && !errors.Is(err, ErrNotFound) {
			return err
		}
		if sess != nil && sess.Status != "active" {
			return fail("conflict", "PROCTORING_FINALIZED", "Proctoring for this session has ended.")
		}
		fresh := sess == nil
		if fresh {
			sess = &Session{
				TenantID: tenant, ID: sessionID, AssessmentID: in.AssessmentID, CandidateID: in.CandidateID,
				Status: "active", Rules: rules, Consent: in.Consent, IDVerification: in.IDVerification,
				ReferenceStatus: "pending", StartedAt: now, CurrentEpoch: 0,
			}
			if !rules.UsesCamera() {
				sess.ReferenceStatus = "verified"
			}
		}
		entry, key, err := s.newKey(sessionID, sess.CurrentEpoch+1, now)
		if err != nil {
			return err
		}
		sess.KeyRing = append(sess.KeyRing, entry)
		sess.CurrentEpoch = entry.Epoch
		sess.TokenHash = hash[:]
		acc, err := r.GetAccommodation(ctx, sessionID)
		if err != nil && !errors.Is(err, ErrNotFound) {
			return err
		}
		if fresh {
			if acc != nil {
				sess.DisabledRules = acc.DisabledRules
			}
			if err := r.InsertSession(ctx, sess); err != nil {
				return err
			}
			if err := s.log(ctx, r, sess, "server", "proctoring_started", 0, now, map[string]any{
				"consent_version": in.Consent["version"], "id_verification": in.IDVerification,
			}); err != nil {
				return err
			}
			if acc != nil {
				if err := s.log(ctx, r, sess, "server", "accommodation_applied", 0, now, map[string]any{
					"disabled_rules": acc.DisabledRules, "reason": acc.Reason, "granted_by": acc.GrantedBy,
				}); err != nil {
					return err
				}
			}
		} else if err := s.log(ctx, r, sess, "server", "proctoring_resumed", 0, now, map[string]any{"key_epoch": entry.Epoch}); err != nil {
			return err
		}
		if err := r.SaveSession(ctx, sess); err != nil {
			return err
		}
		refs := []string{}
		if sess.ReferenceStatus != "verified" {
			refs = append(refs, "selfie")
			if in.IDVerification || sess.IDVerification {
				refs = append(refs, "id_document")
			}
		}
		res = StartResult{
			ProctorToken: token, SessionKey: base64.StdEncoding.EncodeToString(key), KeyEpoch: entry.Epoch,
			NextSeq: sess.LastSeq + 1, PrevHash: sess.LastClientHash, Rules: sess.Rules,
			DisabledRules: append([]string{}, sess.DisabledRules...), ReferencesRequired: refs, ServerTime: now,
		}
		return nil
	})
	return res, err
}

// Authenticate resolves `Authorization: Proctor apt_…` to its session's tenant.
func (s *Service) Authenticate(ctx context.Context, sessionID, header string) (string, error) {
	token, ok := strings.CutPrefix(strings.TrimSpace(header), "Proctor ")
	if !ok || !strings.HasPrefix(token, "apt_") || len(token) > 100 {
		return "", fail("unauthenticated", "PROCTOR_TOKEN_REQUIRED", "Send Authorization: Proctor <token>.")
	}
	hash := sha256.Sum256([]byte(token))
	var tenant string
	err := s.Store.InSystem(ctx, func(r SystemRepo) (err error) {
		tenant, err = r.SessionByToken(ctx, sessionID, hash[:])
		return err
	})
	if errors.Is(err, ErrNotFound) {
		return "", fail("unauthenticated", "PROCTOR_TOKEN_INVALID", "The proctor token is not valid for this session.")
	}
	return tenant, err
}

// --- Ingest --------------------------------------------------------------------------------------

// Batch is one upload of signed events.
type Batch struct {
	SentAt float64           // client clock (ms) when the batch was sent
	Events []json.RawMessage // signed envelopes, in seq order
}

// IngestResult is the reply: counts, a rotated key when due, and notices for the candidate.
type IngestResult struct {
	Accepted   int       `json:"accepted"`
	Duplicates int       `json:"duplicates"`
	Rejected   int       `json:"rejected"`
	LastSeq    int64     `json:"last_seq"`
	KeyEpoch   int       `json:"key_epoch"`
	NextKey    *string   `json:"next_key,omitempty"`
	Notices    []Notice  `json:"notices"`
	ServerTime time.Time `json:"server_time"`
}

// Ingest verifies MACs and the hash chain, de-duplicates on (session, seq), corrects client time
// and runs the rules engine; violations are logged and announced in the same transaction.
func (s *Service) Ingest(ctx context.Context, tenant, sessionID string, b Batch) (IngestResult, error) {
	if len(b.Events) == 0 || len(b.Events) > MaxBatch {
		return IngestResult{}, fail("bad_request", "VALIDATION_FAILED", "A batch has 1–%d events.", MaxBatch)
	}
	now := s.Clock.Now()
	var res IngestResult
	err := s.Store.InTenant(ctx, tenant, func(r TenantRepo) error {
		sess, err := r.GetSession(ctx, sessionID, true)
		if err != nil {
			return err
		}
		if sess.Status != "active" {
			return fail("conflict", "PROCTORING_FINALIZED", "Proctoring for this session has ended.")
		}
		if b.SentAt > 0 {
			if jump, delta := sess.State.Clock.Observe(now, b.SentAt); jump {
				if err := s.findings(ctx, r, sess, now, nil, []domain.Finding{sess.State.Engine.Tamper("clock_jump", map[string]any{"delta_ms": delta})}); err != nil {
					return err
				}
			}
		}
		if sess.State.NetworkGap {
			sess.State.NetworkGap = false
		}
		for _, raw := range b.Events {
			if err := s.ingestOne(ctx, r, sess, raw, now, &res); err != nil {
				return err
			}
		}
		sess.LastEventAt = &now
		if now.Sub(currentKey(sess).IssuedAt) >= KeyRotation {
			entry, key, err := s.newKey(sess.ID, sess.CurrentEpoch+1, now)
			if err != nil {
				return err
			}
			sess.KeyRing = append(sess.KeyRing, entry)
			sess.CurrentEpoch = entry.Epoch
			k := base64.StdEncoding.EncodeToString(key)
			res.NextKey = &k
		}
		res.Notices = append([]Notice{}, sess.State.Notices...)
		sess.State.Notices = nil
		res.LastSeq, res.KeyEpoch, res.ServerTime = sess.LastSeq, sess.CurrentEpoch, now
		return r.SaveSession(ctx, sess)
	})
	return res, err
}

func currentKey(sess *Session) KeyEntry {
	for _, k := range sess.KeyRing {
		if k.Epoch == sess.CurrentEpoch {
			return k
		}
	}
	return KeyEntry{}
}

func (s *Service) ingestOne(ctx context.Context, r TenantRepo, sess *Session, raw json.RawMessage, now time.Time, res *IngestResult) error {
	e, err := domain.ParseEnvelope(raw, sess.ID, func(epoch int) ([]byte, bool) { return s.key(sess, epoch) })
	if errors.Is(err, domain.ErrMalformed) {
		res.Rejected++
		return nil
	}
	if e.Seq > 0 {
		first, cerr := r.ClaimSeq(ctx, sess.ID, e.Seq)
		if cerr != nil {
			return cerr
		}
		if !first {
			res.Duplicates++
			return nil
		}
	}
	occurred := sess.State.Clock.OccurredAt(e.ClientTs, now)
	seq := e.Seq
	if errors.Is(err, domain.ErrBadMAC) {
		// Not authentic: recorded as tamper evidence, never fed to the rules.
		res.Rejected++
		return s.findings(ctx, r, sess, occurred, nil, []domain.Finding{sess.State.Engine.Tamper("bad_mac", map[string]any{"seq": seq})})
	}
	var tamper []domain.Finding
	switch {
	case e.Seq == sess.LastSeq+1 && e.PrevHash != sess.LastClientHash:
		tamper = append(tamper, sess.State.Engine.Tamper("chain_broken", map[string]any{"seq": seq}))
	case e.Seq > sess.LastSeq+1:
		tamper = append(tamper, sess.State.Engine.Tamper("sequence_gap", map[string]any{"seq": seq, "expected": sess.LastSeq + 1}))
	}
	if e.Seq > sess.LastSeq {
		sess.LastSeq, sess.LastClientHash = e.Seq, e.Hash
	}
	res.Accepted++
	payload := map[string]any{}
	for k, v := range e.Payload {
		payload[k] = v
	}
	late := domain.TooLate(occurred, now)
	if late {
		payload["late"] = true
	}
	row := LogRow{SessionID: sess.ID, Source: "client_event", Seq: &seq, EventType: e.Type, Severity: 0, OccurredAt: occurred, ReceivedAt: now, Payload: payload}
	if err := r.AppendLog(ctx, sess, &row); err != nil {
		return err
	}
	if e.Type == "frame" {
		if err := s.frameUploaded(ctx, r, sess, e, occurred); err != nil {
			return err
		}
	}
	var found []domain.Finding
	if !late {
		found = sess.State.Engine.OnClientEvent(sess.Rules, domain.NewDisabled(sess.DisabledRules), e)
	}
	return s.findings(ctx, r, sess, occurred, nil, append(tamper, found...))
}

// frameUploaded hands an announced upload to cv-inference (outbox → Kafka).
func (s *Service) frameUploaded(ctx context.Context, r TenantRepo, sess *Session, e domain.ClientEvent, occurred time.Time) error {
	id, _ := e.Payload["frame_id"].(string)
	if !pgtx.IsUUID(id) {
		return nil
	}
	f, err := r.GetFrame(ctx, id)
	if errors.Is(err, ErrNotFound) || (err == nil && (f.SessionID != sess.ID || f.Status != "awaiting")) {
		return nil
	}
	if err != nil {
		return err
	}
	f.Status, f.CapturedAt = "uploaded", occurred
	if err := r.SaveFrame(ctx, *f); err != nil {
		return err
	}
	return r.AppendOutbox(ctx, events.Outgoing{
		Topic: TopicFrameUploaded, AggregateType: "proctoring_frame", AggregateID: f.ID,
		Payload: map[string]any{
			"tenant_id": sess.TenantID, "session_id": sess.ID, "frame_id": f.ID, "kind": f.Kind,
			"object_key": f.ObjectKey, "captured_at": occurred.Format(time.RFC3339Nano), "triggered": f.Triggered,
		},
	})
}

// findings logs violations, queues notices and announces them; terminations end the session in
// assessment-svc (which consumes the violation event).
func (s *Service) findings(ctx context.Context, r TenantRepo, sess *Session, at time.Time, frameID *string, found []domain.Finding) error {
	for _, f := range found {
		score, _ := domain.TrustScore(sess.State.Engine.Counts)
		detail := map[string]any{"signal": string(f.Signal), "action": f.Action}
		for k, v := range f.Detail {
			detail[k] = v
		}
		row := LogRow{SessionID: sess.ID, Source: "rules", EventType: "violation:" + f.Rule, Severity: f.Severity,
			OccurredAt: at, ReceivedAt: s.Clock.Now(), FrameID: frameID, Payload: detail}
		if err := r.AppendLog(ctx, sess, &row); err != nil {
			return err
		}
		if f.Severity < 2 && f.Action == domain.ActionFlag {
			continue
		}
		sess.State.Notices = append(sess.State.Notices, Notice{Rule: f.Rule, Severity: f.Severity, Action: f.Action})
		if err := r.AppendOutbox(ctx, events.Outgoing{
			Topic: TopicViolation, AggregateType: "assessment_session", AggregateID: sess.ID,
			Payload: map[string]any{
				"tenant_id": sess.TenantID, "session_id": sess.ID, "rule": f.Rule, "severity": f.Severity,
				"action": f.Action, "trust_score": score, "occurred_at": at.UTC().Format(time.RFC3339Nano),
			},
		}); err != nil {
			return err
		}
	}
	return nil
}

func (s *Service) log(ctx context.Context, r TenantRepo, sess *Session, source, typ string, severity int, at time.Time, payload map[string]any) error {
	row := LogRow{SessionID: sess.ID, Source: source, EventType: typ, Severity: severity, OccurredAt: at, ReceivedAt: s.Clock.Now(), Payload: payload}
	return r.AppendLog(ctx, sess, &row)
}

// --- Uploads -------------------------------------------------------------------------------------

// UploadInput asks for a presigned upload.
type UploadInput struct {
	Kind        string
	ContentType string
	Triggered   bool
}

var uploadTypes = map[string]map[string]string{
	"frame":       {"image/jpeg": "jpg"},
	"selfie":      {"image/jpeg": "jpg"},
	"id_document": {"image/jpeg": "jpg"},
	"audio":       {"audio/webm": "webm", "audio/ogg": "ogg"},
}

// InitiateUpload returns a presigned POST for t/{tid}/proctor/{sid}/{frame_id}.{ext}. The upload
// is announced to cv-inference only when a signed `frame` event names it.
func (s *Service) InitiateUpload(ctx context.Context, tenant, sessionID string, in UploadInput) (string, Upload, error) {
	ext, ok := uploadTypes[in.Kind][in.ContentType]
	if !ok {
		return "", Upload{}, fail("rule", "UNSUPPORTED_UPLOAD", "Upload kind %q with type %q is not accepted.", in.Kind, in.ContentType)
	}
	var id, key string
	err := s.Store.InTenant(ctx, tenant, func(r TenantRepo) error {
		sess, err := r.GetSession(ctx, sessionID, false)
		if err != nil {
			return err
		}
		if sess.Status != "active" {
			return fail("conflict", "PROCTORING_FINALIZED", "Proctoring for this session has ended.")
		}
		if (in.Kind == "selfie" || in.Kind == "id_document") && sess.State.References >= MaxReferences {
			return fail("conflict", "REFERENCES_COMPLETE", "The reference images are already recorded.")
		}
		n, err := r.CountFrames(ctx, sessionID)
		if err != nil {
			return err
		}
		if n >= MaxFrames {
			return &domain.RuleError{Code: "UPLOAD_LIMIT", Message: "This session has reached its upload limit.", Kind: "throttled"}
		}
		id = s.NewID()
		key = fmt.Sprintf("t/%s/proctor/%s/%s.%s", tenant, sessionID, id, ext)
		return r.InsertFrame(ctx, Frame{TenantID: tenant, ID: id, SessionID: sessionID, Kind: in.Kind, ObjectKey: key,
			CapturedAt: s.Clock.Now(), Triggered: in.Triggered, Status: "awaiting"})
	})
	if err != nil {
		return "", Upload{}, err
	}
	max := int64(ImageMaxBytes)
	if in.Kind == "audio" {
		max = AudioMaxBytes
	}
	up, err := s.Blobs.PresignUpload(ctx, key, in.ContentType, max, UploadTTL)
	return id, up, err
}

// --- Inference results ---------------------------------------------------------------------------

// InferenceResult is what cv-inference posts for one frame, reference image or audio window.
type InferenceResult struct {
	ModelVersions map[string]string
	Luminance     float64
	BlurVariance  float64
	Faces         int
	Embedding     []float32 // the largest face; never stored for frames
	Objects       []string
	PHash         string
	HeadPose      map[string]float64
	Speakers      int
	SpeechS       float64
	WindowS       float64
	Error         string // object_missing, undecodable
}

// Inference applies a result: references are stored encrypted; frames and audio go through the
// rules engine (late results flag but never terminate). Called by cv-inference.
func (s *Service) Inference(ctx context.Context, p auth.Principal, tenant, frameID string, in InferenceResult) error {
	if !p.IsService(ScopeInference) {
		return fail("forbidden", "FORBIDDEN", "This operation needs the %s scope.", ScopeInference)
	}
	if in.Embedding != nil && len(in.Embedding) != EmbeddingDims {
		return fail("bad_request", "VALIDATION_FAILED", "embedding must have %d dimensions.", EmbeddingDims)
	}
	now := s.Clock.Now()
	var refinalize bool
	err := s.Store.InTenant(ctx, tenant, func(r TenantRepo) error {
		f, err := r.GetFrame(ctx, frameID)
		if err != nil {
			return err
		}
		if f.Status == "analysed" {
			return nil // a redelivered result: already applied
		}
		sess, err := r.GetSession(ctx, f.SessionID, true)
		if err != nil {
			return err
		}
		f.Status = "analysed"
		model := modelString(in.ModelVersions)
		payload := map[string]any{"kind": f.Kind, "faces": in.Faces, "luminance": round1(in.Luminance),
			"blur_variance": round1(in.BlurVariance), "objects": in.Objects}
		if in.HeadPose != nil {
			payload["head_pose"] = in.HeadPose
		}
		var found []domain.Finding
		source := "frame_inference"
		switch {
		case in.Error != "":
			payload["error"] = in.Error
		case f.Kind == "selfie" || f.Kind == "id_document":
			found, err = s.reference(sess, f, in, payload)
			if err != nil {
				return err
			}
		case f.Kind == "audio":
			source = "audio_inference"
			payload = map[string]any{"speakers": in.Speakers, "speech_s": in.SpeechS, "window_s": in.WindowS}
			found = sess.State.Engine.OnAudio(sess.Rules, domain.NewDisabled(sess.DisabledRules), in.Speakers, in.WindowS)
		default:
			fr := domain.FrameResult{Luminance: in.Luminance, BlurVariance: in.BlurVariance, Faces: in.Faces, Objects: in.Objects, PHash: in.PHash}
			if in.Faces == 1 && in.Embedding != nil {
				if c, ok, cerr := s.bestCosine(sess, in.Embedding); cerr != nil {
					return cerr
				} else if ok {
					fr.Cosine = &c
					payload["cosine"] = math.Round(c*1000) / 1000
				}
			}
			if fr.LowQuality() {
				payload["low_quality"] = true
			}
			late := now.Sub(f.CapturedAt) > domain.LateInferenceMs*time.Millisecond
			if late {
				payload["late_inference_ms"] = now.Sub(f.CapturedAt).Milliseconds()
			}
			found = sess.State.Engine.OnFrame(sess.Rules, domain.NewDisabled(sess.DisabledRules), fr, late)
			if err := s.trackStreaks(ctx, r, sess, f.ID, fr, found); err != nil {
				return err
			}
		}
		fid := f.ID
		row := LogRow{SessionID: sess.ID, Source: source, EventType: "inference:" + f.Kind, OccurredAt: f.CapturedAt,
			ReceivedAt: now, FrameID: &fid, ModelVersion: model, Payload: payload}
		if err := r.AppendLog(ctx, sess, &row); err != nil {
			return err
		}
		if len(found) > 0 {
			f.Flagged = true
		}
		if err := r.SaveFrame(ctx, *f); err != nil {
			return err
		}
		if err := s.findings(ctx, r, sess, f.CapturedAt, &fid, found); err != nil {
			return err
		}
		refinalize = sess.Status == "finalized" && len(found) > 0
		return r.SaveSession(ctx, sess)
	})
	if err != nil || !refinalize {
		return err
	}
	// Results that arrive after the report was computed revise it (PRD: processing completes
	// before the report; a lagging GPU queue must not lose evidence).
	f, ferr := s.frameSession(ctx, tenant, frameID)
	if ferr != nil {
		return ferr
	}
	return s.Finalize(ctx, tenant, f, true)
}

func (s *Service) frameSession(ctx context.Context, tenant, frameID string) (string, error) {
	var sid string
	err := s.Store.InTenant(ctx, tenant, func(r TenantRepo) error {
		f, err := r.GetFrame(ctx, frameID)
		if err == nil {
			sid = f.SessionID
		}
		return err
	})
	return sid, err
}

func modelString(m map[string]string) *string {
	if len(m) == 0 {
		return nil
	}
	b, _ := json.Marshal(m)
	s := string(b)
	return &s
}

func round1(f float64) float64 { return math.Round(f*10) / 10 }

// reference stores the selfie embedding (and the ID's, when it matches) encrypted, for this
// session only; an ID that does not match goes to a reviewer, never to an automatic rejection.
func (s *Service) reference(sess *Session, f *Frame, in InferenceResult, payload map[string]any) ([]domain.Finding, error) {
	refs, err := s.references(sess)
	if err != nil {
		return nil, err
	}
	if in.Faces != 1 || in.Embedding == nil {
		if f.Kind == "selfie" && len(refs) == 0 {
			sess.ReferenceStatus = "no_face"
			sess.State.Notices = append(sess.State.Notices, Notice{Rule: "retake_selfie", Severity: 1, Action: domain.ActionFlag})
		}
		payload["reference"] = "rejected"
		return nil, nil
	}
	if f.Kind == "id_document" {
		if len(refs) == 0 {
			payload["reference"] = "no_selfie"
			return nil, nil
		}
		c := maxCosine(in.Embedding, refs)
		payload["cosine"] = math.Round(c*1000) / 1000
		if c < domain.FaceMatchMinCosine {
			sess.ReferenceStatus = "id_mismatch"
			return []domain.Finding{{Rule: "id_mismatch", Severity: 3, Action: domain.ActionReview, Detail: map[string]any{"cosine": payload["cosine"]}}}, nil
		}
	}
	if len(refs) >= MaxReferences {
		payload["reference"] = "limit"
		return nil, nil
	}
	refs = append(refs, normalize(in.Embedding))
	if err := s.storeReferences(sess, refs); err != nil {
		return nil, err
	}
	if sess.ReferenceStatus != "id_mismatch" {
		sess.ReferenceStatus = "verified"
	}
	payload["reference"] = "stored"
	return nil, nil
}

func (s *Service) references(sess *Session) ([][]float32, error) {
	if len(sess.References) == 0 {
		return nil, nil
	}
	plain, err := s.Cipher.Open(sess.References, "refs:"+sess.ID)
	if err != nil {
		return nil, err
	}
	var refs [][]float32
	err = json.Unmarshal(plain, &refs)
	return refs, err
}

func (s *Service) storeReferences(sess *Session, refs [][]float32) error {
	plain, _ := json.Marshal(refs)
	sealed, err := s.Cipher.Seal(plain, "refs:"+sess.ID)
	if err != nil {
		return err
	}
	sess.References = sealed
	sess.State.References = len(refs)
	return nil
}

func (s *Service) bestCosine(sess *Session, emb []float32) (float64, bool, error) {
	refs, err := s.references(sess)
	if err != nil || len(refs) == 0 {
		return 0, false, err
	}
	return maxCosine(emb, refs), true, nil
}

func normalize(v []float32) []float32 {
	var n float64
	for _, x := range v {
		n += float64(x) * float64(x)
	}
	n = math.Sqrt(n)
	out := make([]float32, len(v))
	if n == 0 {
		return out
	}
	for i, x := range v {
		out[i] = float32(float64(x) / n)
	}
	return out
}

func maxCosine(v []float32, refs [][]float32) float64 {
	u := normalize(v)
	best := -1.0
	for _, r := range refs {
		var dot float64
		for i := range u {
			if i < len(r) {
				dot += float64(u[i]) * float64(r[i])
			}
		}
		best = math.Max(best, dot)
	}
	return best
}

// trackStreaks keeps the frames of each running streak and flags all of them as evidence when
// the streak becomes a violation (low-quality frames neither join nor break a streak).
func (s *Service) trackStreaks(ctx context.Context, r TenantRepo, sess *Session, frameID string, fr domain.FrameResult, found []domain.Finding) error {
	if fr.LowQuality() {
		return nil
	}
	if sess.State.StreakFrames == nil {
		sess.State.StreakFrames = map[string][]string{}
	}
	fired := map[string]bool{}
	for _, f := range found {
		fired[f.Rule] = true
	}
	for _, flag := range sess.Rules.Image.Flags {
		switch {
		case fired[flag]:
			for _, id := range sess.State.StreakFrames[flag] {
				prev, err := r.GetFrame(ctx, id)
				if errors.Is(err, ErrNotFound) {
					continue
				}
				if err != nil {
					return err
				}
				if !prev.Flagged {
					prev.Flagged = true
					if err := r.SaveFrame(ctx, *prev); err != nil {
						return err
					}
				}
			}
			delete(sess.State.StreakFrames, flag)
		case sess.State.Engine.Streaks[flag] > 0:
			sess.State.StreakFrames[flag] = append(sess.State.StreakFrames[flag], frameID)
		default:
			delete(sess.State.StreakFrames, flag)
		}
	}
	return nil
}
