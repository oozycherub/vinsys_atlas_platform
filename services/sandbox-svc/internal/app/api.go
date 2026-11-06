package app

import (
	"atlas.dev/go-platform/auth"
	"context"
	"encoding/hex"
	"errors"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"atlas.dev/sandbox-svc/internal/domain"
)

// Principal is the verified caller (JWT claims).
type Principal = auth.Principal

// Scopes for service callers (assessment-svc).
const (
	ScopeExecute = "sandbox:execute"
	ScopeBundles = "sandbox:bundles"
)

// StaffRoles may read their tenant's bundles and submissions.
var StaffRoles = []string{"tenant_admin", "recruiter", "hiring_manager", "reviewer", "sme"}

// RunInterval: at most one run per 3 s per session (PRD §2.2b).
const RunInterval = 3 * time.Second

func isStaff(p Principal) bool { return p.HasAnyRole(StaffRoles...) }

func forbidden(msg string) error {
	return &domain.RuleError{Code: "FORBIDDEN", Message: msg, Kind: "forbidden"}
}

// tenantFor resolves the tenant: tenant users act on their own tenant; service and platform
// principals must name it (MASTER_ORCHESTRATION_PROMPT §4.3).
func tenantFor(p Principal, requested string) (string, error) {
	if p.TenantID != nil {
		if requested != "" && requested != *p.TenantID {
			return "", forbidden("You cannot act on another tenant.")
		}
		return *p.TenantID, nil
	}
	if requested == "" {
		return "", &domain.RuleError{Code: "TENANT_REQUIRED", Message: "tenant_id is required for this caller.", Kind: "bad_request"}
	}
	return requested, nil
}

// requireService checks a service principal with the scope.
func requireService(p Principal, scope string) error {
	if p.IsService(scope) {
		return nil
	}
	return forbidden("This operation needs the " + scope + " scope.")
}

// API implements the judge's HTTP use cases.
type API struct {
	Store Store
	Blobs BlobStore
	Clock Clock
	NewID func() string

	langMu    sync.Mutex
	langCache []domain.Language
	langAt    time.Time
}

// Languages returns the registry (cached for a minute).
func (a *API) Languages(ctx context.Context) ([]domain.Language, error) {
	a.langMu.Lock()
	defer a.langMu.Unlock()
	if a.langCache != nil && a.Clock.Now().Sub(a.langAt) < time.Minute {
		return a.langCache, nil
	}
	var langs []domain.Language
	if err := a.Store.InSystem(ctx, func(r SystemRepo) (err error) {
		langs, err = r.Languages(ctx)
		return err
	}); err != nil {
		return nil, err
	}
	a.langCache, a.langAt = langs, a.Clock.Now()
	return langs, nil
}

// EnabledLanguages lists what candidates may use.
func (a *API) EnabledLanguages(ctx context.Context) ([]domain.Language, error) {
	all, err := a.Languages(ctx)
	if err != nil {
		return nil, err
	}
	var out []domain.Language
	for _, l := range all {
		if l.Enabled {
			out = append(out, l)
		}
	}
	return out, nil
}

func (a *API) language(ctx context.Context, slug string) (domain.Language, error) {
	all, err := a.Languages(ctx)
	if err != nil {
		return domain.Language{}, err
	}
	for _, l := range all {
		if l.Slug == slug {
			if !l.Enabled {
				return l, &domain.RuleError{Code: "LANGUAGE_DISABLED", Message: l.Name + " is disabled."}
			}
			return l, nil
		}
	}
	return domain.Language{}, &domain.RuleError{Code: "UNKNOWN_LANGUAGE", Message: "Unknown language " + strconv.Quote(slug) + "."}
}

// BundleInput is the registration request.
type BundleInput struct {
	Languages       []string
	Tests           []domain.TestCase
	Checker         domain.CheckerSpec
	CheckerLanguage string
	CheckerSource   string
	Limits          domain.LimitOverrides
	RefLanguage     string
	RefSource       string
}

// PutBundle registers a question version's tests and queues the reference verification.
// It returns the bundle and whether it was newly created or replaced.
func (a *API) PutBundle(ctx context.Context, p Principal, tenantParam, questionID string, version int, in BundleInput) (Bundle, bool, error) {
	if err := requireService(p, ScopeBundles); err != nil {
		return Bundle{}, false, err
	}
	tenant, err := tenantFor(p, tenantParam)
	if err != nil {
		return Bundle{}, false, err
	}
	if version < 1 {
		return Bundle{}, false, &domain.RuleError{Code: "INVALID_VERSION", Message: "version must be ≥ 1.", Kind: "bad_request"}
	}
	if len(in.Languages) == 0 || len(in.Languages) > 40 {
		return Bundle{}, false, &domain.RuleError{Code: "INVALID_LANGUAGES", Message: "A question offers 1–40 languages."}
	}
	for _, slug := range in.Languages {
		if _, err := a.language(ctx, slug); err != nil {
			return Bundle{}, false, err
		}
	}
	if in.Checker.Kind == "" {
		in.Checker.Kind = domain.CheckTrimWS
	}
	if err := domain.ValidateChecker(in.Checker); err != nil {
		return Bundle{}, false, err
	}
	if err := in.Limits.Validate(); err != nil {
		return Bundle{}, false, err
	}
	if err := domain.ValidateTests(in.Tests); err != nil {
		return Bundle{}, false, err
	}
	ref, err := a.language(ctx, in.RefLanguage)
	if err != nil {
		return Bundle{}, false, err
	}
	if !slices.Contains(in.Languages, ref.Slug) {
		return Bundle{}, false, &domain.RuleError{Code: "INVALID_REFERENCE", Message: "The reference solution must use one of the question's languages."}
	}
	if len(in.RefSource) == 0 || len(in.RefSource) > domain.MaxSourceBytes {
		return Bundle{}, false, &domain.RuleError{Code: "SOURCE_TOO_LARGE", Message: "The reference solution must be 1 byte to 64 KB."}
	}
	b := Bundle{
		TenantID: tenant, QuestionID: questionID, Version: version, Checker: in.Checker, Limits: in.Limits,
		Languages: append([]string(nil), in.Languages...), ReferenceLangID: ref.ID, ReferenceSource: in.RefSource,
		Status: "pending", CreatedAt: a.Clock.Now(),
	}
	if in.Checker.Kind == domain.CheckCustom {
		cl, err := a.language(ctx, in.CheckerLanguage)
		if err != nil {
			return Bundle{}, false, err
		}
		if in.CheckerSource == "" || len(in.CheckerSource) > domain.MaxSourceBytes {
			return Bundle{}, false, &domain.RuleError{Code: "INVALID_CHECKER", Message: "A custom checker needs source code (≤ 64 KB)."}
		}
		id, src := cl.ID, in.CheckerSource
		b.CheckerLanguageID, b.CheckerSource = &id, &src
	}
	// Stable test ids: the ordinal within the version.
	content := domain.BundleContent{Tests: make([]domain.TestCase, len(in.Tests))}
	for i, t := range in.Tests {
		if t.Weight == 0 {
			t.Weight = 1
		}
		t.ID = "t" + strconv.Itoa(i+1)
		content.Tests[i] = t
		b.TestCount++
		if !t.Hidden {
			b.SampleCount++
		}
	}
	data, sum, err := content.Encode()
	if err != nil {
		return Bundle{}, false, err
	}
	b.Checksum = sum
	b.ObjectKey = "t/" + tenant + "/sandbox/bundles/" + questionID + "/" + strconv.Itoa(version) + "/" + hex.EncodeToString(sum[:]) + ".json"

	var existing *Bundle
	if err := a.Store.InTenant(ctx, tenant, func(r TenantRepo) (err error) {
		existing, err = r.GetBundle(ctx, questionID, version)
		if errors.Is(err, ErrNotFound) {
			return nil
		}
		return err
	}); err != nil {
		return Bundle{}, false, err
	}
	if existing != nil {
		same := existing.Checksum == b.Checksum && sameBundleSettings(*existing, b)
		if same && existing.Status != "flaky" && existing.Status != "reference_failed" {
			return *existing, false, nil // idempotent re-registration
		}
		if existing.Status == "verified" {
			return Bundle{}, false, domain.Conflict("BUNDLE_IMMUTABLE", "A verified question version cannot change; create a new version.")
		}
	}
	if err := a.Blobs.Put(ctx, b.ObjectKey, data); err != nil {
		return Bundle{}, false, err
	}
	verifyID := a.NewID()
	err = a.Store.InTenant(ctx, tenant, func(r TenantRepo) error {
		if err := r.UpsertBundle(ctx, b); err != nil {
			return err
		}
		_, _, err := r.InsertSubmission(ctx, Submission{
			TenantID: tenant, ID: verifyID, QuestionID: questionID, QuestionVersion: version,
			LanguageID: ref.ID, Mode: "verify", Lane: domain.LaneSubmit,
			IdempotencyKey: "verify:" + verifyID, Source: in.RefSource, SourceSHA256: SourceHash(in.RefSource),
			Status: domain.Queued, QueuedAt: a.Clock.Now(),
		})
		return err
	})
	return b, true, err
}

func sameBundleSettings(a, b Bundle) bool {
	return a.Checker == b.Checker && a.Limits == b.Limits && slices.Equal(a.Languages, b.Languages) &&
		a.ReferenceLangID == b.ReferenceLangID && a.ReferenceSource == b.ReferenceSource &&
		eqPtr(a.CheckerLanguageID, b.CheckerLanguageID) && eqPtr(a.CheckerSource, b.CheckerSource)
}

func eqPtr[T comparable](a, b *T) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}

// GetBundle reads a bundle (service with bundles scope, or tenant staff).
func (a *API) GetBundle(ctx context.Context, p Principal, tenantParam, questionID string, version int) (Bundle, error) {
	if requireService(p, ScopeBundles) != nil && !isStaff(p) {
		return Bundle{}, forbidden("Your role cannot read test-case bundles.")
	}
	tenant, err := tenantFor(p, tenantParam)
	if err != nil {
		return Bundle{}, err
	}
	var b *Bundle
	err = a.Store.InTenant(ctx, tenant, func(r TenantRepo) (err error) {
		b, err = r.GetBundle(ctx, questionID, version)
		return err
	})
	if errors.Is(err, ErrNotFound) {
		return Bundle{}, domain.NotFound("BUNDLE_NOT_FOUND", "No test cases are registered for this question version.")
	}
	if err != nil {
		return Bundle{}, err
	}
	return *b, nil
}

// ExecInput is a run or submission request (from assessment-svc).
type ExecInput struct {
	SessionID       string
	QuestionID      string
	QuestionVersion int
	AssessmentID    *string
	CandidateID     string
	Language        string
	Source          string
	Stdin           *string
	ActiveUntil     *time.Time
	IdempotencyKey  string
}

func (a *API) prepare(ctx context.Context, r TenantRepo, in ExecInput, needVerified bool) (domain.Language, error) {
	if in.ActiveUntil != nil && !a.Clock.Now().Before(*in.ActiveUntil) {
		return domain.Language{}, domain.Conflict("SESSION_NOT_ACTIVE", "The session has ended.")
	}
	if len(in.Source) == 0 || len(in.Source) > domain.MaxSourceBytes {
		return domain.Language{}, &domain.RuleError{Code: "SOURCE_TOO_LARGE", Message: "Source code must be 1 byte to 64 KB."}
	}
	if in.Stdin != nil && len(*in.Stdin) > domain.MaxStdinBytes {
		return domain.Language{}, &domain.RuleError{Code: "STDIN_TOO_LARGE", Message: "Custom input must be at most 64 KB."}
	}
	lang, err := a.language(ctx, in.Language)
	if err != nil {
		return domain.Language{}, err
	}
	b, err := r.GetBundle(ctx, in.QuestionID, in.QuestionVersion)
	if errors.Is(err, ErrNotFound) {
		return domain.Language{}, &domain.RuleError{Code: "BUNDLE_NOT_FOUND", Message: "This question has no registered test cases."}
	}
	if err != nil {
		return domain.Language{}, err
	}
	if !slices.Contains(b.Languages, lang.Slug) {
		return domain.Language{}, &domain.RuleError{Code: "LANGUAGE_NOT_ALLOWED", Message: lang.Name + " is not offered for this question."}
	}
	if needVerified && b.Status != "verified" {
		return domain.Language{}, &domain.RuleError{Code: "BUNDLE_NOT_VERIFIED", Message: "This question's tests are not verified yet."}
	}
	return lang, nil
}

// CreateRun queues a run (sample tests or custom stdin), at most one per 3 s per session.
func (a *API) CreateRun(ctx context.Context, p Principal, tenantParam string, in ExecInput) (Submission, error) {
	if err := requireService(p, ScopeExecute); err != nil {
		return Submission{}, err
	}
	tenant, err := tenantFor(p, tenantParam)
	if err != nil {
		return Submission{}, err
	}
	var created Submission
	err = a.Store.InTenant(ctx, tenant, func(r TenantRepo) error {
		lang, err := a.prepare(ctx, r, in, false)
		if err != nil {
			return err
		}
		if err := r.LockSession(ctx, in.SessionID); err != nil {
			return err
		}
		last, err := r.LastRunAt(ctx, in.SessionID)
		if err != nil {
			return err
		}
		now := a.Clock.Now()
		if last != nil && now.Sub(*last) < RunInterval {
			wait := int((RunInterval - now.Sub(*last) + time.Second - 1) / time.Second)
			return &domain.RuleError{Code: "RUN_THROTTLED", Message: "One run every 3 seconds; try again shortly.", Kind: "throttled", RetryAfterSec: max(1, wait)}
		}
		id := a.NewID()
		created, _, err = r.InsertSubmission(ctx, a.newSubmission(tenant, id, in, lang, "run", domain.LaneInteractive, "run:"+id, now))
		return err
	})
	return created, err
}

// CreateSubmission queues a final submission; the same idempotency key returns the same row.
func (a *API) CreateSubmission(ctx context.Context, p Principal, tenantParam string, in ExecInput) (Submission, bool, error) {
	if err := requireService(p, ScopeExecute); err != nil {
		return Submission{}, false, err
	}
	tenant, err := tenantFor(p, tenantParam)
	if err != nil {
		return Submission{}, false, err
	}
	if len(in.IdempotencyKey) < 8 || len(in.IdempotencyKey) > 128 {
		return Submission{}, false, &domain.RuleError{Code: "IDEMPOTENCY_KEY_REQUIRED", Message: "Send an Idempotency-Key header (8–128 characters).", Kind: "precondition_required"}
	}
	in.Stdin = nil
	var sub Submission
	var created bool
	err = a.Store.InTenant(ctx, tenant, func(r TenantRepo) error {
		lang, err := a.prepare(ctx, r, in, true)
		if err != nil {
			return err
		}
		candidate := a.newSubmission(tenant, a.NewID(), in, lang, "submit", domain.LaneSubmit, "submit:"+in.IdempotencyKey, a.Clock.Now())
		sub, created, err = r.InsertSubmission(ctx, candidate)
		if err != nil {
			return err
		}
		if !created && (deref(sub.SessionID) != in.SessionID || sub.QuestionID != in.QuestionID || sub.SourceSHA256 != candidate.SourceSHA256 || sub.LanguageID != lang.ID) {
			return &domain.RuleError{Code: "IDEMPOTENCY_KEY_REUSED", Message: "This Idempotency-Key was used for a different submission."}
		}
		return nil
	})
	return sub, created, err
}

func (a *API) newSubmission(tenant, id string, in ExecInput, lang domain.Language, mode string, lane domain.Lane, key string, now time.Time) Submission {
	session, candidate := in.SessionID, in.CandidateID
	return Submission{
		TenantID: tenant, ID: id, SessionID: &session, AssessmentID: in.AssessmentID, CandidateID: &candidate,
		QuestionID: in.QuestionID, QuestionVersion: in.QuestionVersion, LanguageID: lang.ID, Mode: mode, Lane: lane,
		IdempotencyKey: key, Source: in.Source, SourceSHA256: SourceHash(in.Source), Stdin: in.Stdin,
		Status: domain.Queued, QueuedAt: now,
	}
}

// GetRun returns a run, long-polling up to wait for it to finish.
func (a *API) GetRun(ctx context.Context, p Principal, tenantParam, id string, wait time.Duration) (Submission, []domain.CaseResult, error) {
	if err := requireService(p, ScopeExecute); err != nil {
		return Submission{}, nil, err
	}
	tenant, err := tenantFor(p, tenantParam)
	if err != nil {
		return Submission{}, nil, err
	}
	deadline := time.Now().Add(min(wait, 10*time.Second))
	for {
		s, cases, err := a.load(ctx, tenant, id, "run")
		if err != nil || s.Status.IsFinal() || !time.Now().Before(deadline) {
			return s, cases, err
		}
		select {
		case <-ctx.Done():
			return s, cases, nil
		case <-time.After(150 * time.Millisecond):
		}
	}
}

// GetSubmission returns a submission. Staff may ask for the staff view.
func (a *API) GetSubmission(ctx context.Context, p Principal, tenantParam, id string, staffView bool) (Submission, []domain.CaseResult, error) {
	switch {
	case staffView && !isStaff(p) && !p.HasRole("super_admin"):
		return Submission{}, nil, forbidden("The staff view needs a staff role.")
	case !staffView && requireService(p, ScopeExecute) != nil:
		return Submission{}, nil, forbidden("This operation needs the sandbox:execute scope.")
	}
	tenant, err := tenantFor(p, tenantParam)
	if err != nil {
		return Submission{}, nil, err
	}
	return a.load(ctx, tenant, id, "submit")
}

func (a *API) load(ctx context.Context, tenant, id, mode string) (Submission, []domain.CaseResult, error) {
	var s *Submission
	var cases []domain.CaseResult
	err := a.Store.InTenant(ctx, tenant, func(r TenantRepo) (err error) {
		if s, err = r.GetSubmission(ctx, id); err != nil {
			return err
		}
		cases, err = r.Results(ctx, id)
		return err
	})
	if errors.Is(err, ErrNotFound) || (err == nil && s.Mode != mode) {
		name := map[string]string{"run": "RUN_NOT_FOUND", "submit": "SUBMISSION_NOT_FOUND"}[mode]
		return Submission{}, nil, domain.NotFound(name, "No such "+strings.ToLower(strings.Split(name, "_")[0])+".")
	}
	if err != nil {
		return Submission{}, nil, err
	}
	return *s, cases, nil
}

// Ready checks the database.
func (a *API) Ready(ctx context.Context) error { return a.Store.Ping(ctx) }
