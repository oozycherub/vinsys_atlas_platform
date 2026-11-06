package httpapi

import (
	"encoding/hex"
	"net/http"
	"strconv"
	"time"

	"atlas.dev/sandbox-svc/internal/app"
	"atlas.dev/sandbox-svc/internal/domain"
)

func (s *Server) languages(w http.ResponseWriter, r *http.Request, _ app.Principal) error {
	langs, err := s.API.EnabledLanguages(r.Context())
	if err != nil {
		return err
	}
	items := make([]map[string]any, 0, len(langs))
	for _, l := range langs {
		limits, _ := domain.Resolve(domain.LimitOverrides{}, l)
		items = append(items, map[string]any{
			"language_id": l.ID, "slug": l.Slug, "name": l.Name, "compiled": l.CompileCmd != "",
			"default_limits": limits,
		})
	}
	writeJSON(w, 200, map[string]any{"items": items})
	return nil
}

type bundleBody struct {
	Languages []string `json:"languages"`
	Tests     []struct {
		Input    *string  `json:"input"`
		Expected *string  `json:"expected"`
		Hidden   *bool    `json:"hidden"`
		Weight   *float64 `json:"weight"`
	} `json:"tests"`
	Checker *struct {
		Kind      string  `json:"kind"`
		Tolerance float64 `json:"tolerance"`
		Language  string  `json:"language"`
		Source    string  `json:"source"`
	} `json:"checker"`
	Limits            *domain.LimitOverrides `json:"limits"`
	ReferenceSolution *struct {
		Language string `json:"language"`
		Source   string `json:"source"`
	} `json:"reference_solution"`
}

func (s *Server) putBundle(w http.ResponseWriter, r *http.Request, p app.Principal) error {
	qid, err := pathUUID(r, "questionId")
	if err != nil {
		return err
	}
	version, err := strconv.Atoi(r.PathValue("version"))
	if err != nil {
		return badRequest("version must be an integer.")
	}
	tenant, err := tenantParam(r)
	if err != nil {
		return err
	}
	var body bundleBody
	if err := decodeBody(w, r, BundleBodyLimit, &body); err != nil {
		return err
	}
	if body.ReferenceSolution == nil {
		return badRequest("reference_solution is required.")
	}
	in := app.BundleInput{Languages: body.Languages, RefLanguage: body.ReferenceSolution.Language, RefSource: body.ReferenceSolution.Source}
	for i, t := range body.Tests {
		if t.Input == nil || t.Expected == nil {
			return badRequest("tests[" + strconv.Itoa(i) + "] needs input and expected.")
		}
		tc := domain.TestCase{Input: *t.Input, Expected: *t.Expected, Hidden: true, Weight: 1}
		if t.Hidden != nil {
			tc.Hidden = *t.Hidden
		}
		if t.Weight != nil {
			tc.Weight = *t.Weight
		}
		in.Tests = append(in.Tests, tc)
	}
	if body.Checker != nil {
		in.Checker = domain.CheckerSpec{Kind: body.Checker.Kind, Tolerance: body.Checker.Tolerance}
		in.CheckerLanguage, in.CheckerSource = body.Checker.Language, body.Checker.Source
	}
	if body.Limits != nil {
		in.Limits = *body.Limits
	}
	b, created, err := s.API.PutBundle(r.Context(), p, tenant, qid, version, in)
	if err != nil {
		return err
	}
	status := 200
	if created {
		status = 201
	}
	writeJSON(w, status, bundleView(b))
	return nil
}

func (s *Server) getBundle(w http.ResponseWriter, r *http.Request, p app.Principal) error {
	qid, err := pathUUID(r, "questionId")
	if err != nil {
		return err
	}
	version, err := strconv.Atoi(r.PathValue("version"))
	if err != nil {
		return badRequest("version must be an integer.")
	}
	tenant, err := tenantParam(r)
	if err != nil {
		return err
	}
	b, err := s.API.GetBundle(r.Context(), p, tenant, qid, version)
	if err != nil {
		return err
	}
	writeJSON(w, 200, bundleView(b))
	return nil
}

func bundleView(b app.Bundle) map[string]any {
	return map[string]any{
		"question_id": b.QuestionID, "version": b.Version, "status": b.Status, "status_detail": b.StatusDetail,
		"test_count": b.TestCount, "sample_count": b.SampleCount, "languages": b.Languages,
		"checksum": hex.EncodeToString(b.Checksum[:]), "verified_at": b.VerifiedAt,
	}
}

type execBody struct {
	Language        string     `json:"language"`
	Source          string     `json:"source"`
	QuestionVersion int        `json:"question_version"`
	AssessmentID    *string    `json:"assessment_id"`
	CandidateID     string     `json:"candidate_id"`
	ActiveUntil     *time.Time `json:"active_until"`
	Stdin           *string    `json:"stdin"`
}

func (s *Server) execInput(w http.ResponseWriter, r *http.Request, allowStdin bool) (app.ExecInput, string, error) {
	session, err := pathUUID(r, "sessionId")
	if err != nil {
		return app.ExecInput{}, "", err
	}
	qid, err := pathUUID(r, "questionId")
	if err != nil {
		return app.ExecInput{}, "", err
	}
	tenant, err := tenantParam(r)
	if err != nil {
		return app.ExecInput{}, "", err
	}
	var b execBody
	if err := decodeBody(w, r, DefaultBodyLimit, &b); err != nil {
		return app.ExecInput{}, "", err
	}
	switch {
	case b.Language == "" || b.QuestionVersion < 1:
		return app.ExecInput{}, "", badRequest("language and question_version are required.")
	case !isUUID(b.CandidateID):
		return app.ExecInput{}, "", badRequest("candidate_id must be a UUID.")
	case b.AssessmentID != nil && !isUUID(*b.AssessmentID):
		return app.ExecInput{}, "", badRequest("assessment_id must be a UUID.")
	case b.Stdin != nil && !allowStdin:
		return app.ExecInput{}, "", badRequest("stdin is only accepted for runs.")
	}
	return app.ExecInput{
		SessionID: session, QuestionID: qid, QuestionVersion: b.QuestionVersion, AssessmentID: b.AssessmentID,
		CandidateID: b.CandidateID, Language: b.Language, Source: b.Source, Stdin: b.Stdin, ActiveUntil: b.ActiveUntil,
	}, tenant, nil
}

func (s *Server) createRun(w http.ResponseWriter, r *http.Request, p app.Principal) error {
	in, tenant, err := s.execInput(w, r, true)
	if err != nil {
		return err
	}
	run, err := s.API.CreateRun(r.Context(), p, tenant, in)
	if err != nil {
		return err
	}
	writeJSON(w, 202, map[string]any{"run_id": run.ID, "status": run.Status})
	return nil
}

func (s *Server) createSubmission(w http.ResponseWriter, r *http.Request, p app.Principal) error {
	in, tenant, err := s.execInput(w, r, false)
	if err != nil {
		return err
	}
	in.IdempotencyKey = r.Header.Get("Idempotency-Key")
	sub, _, err := s.API.CreateSubmission(r.Context(), p, tenant, in)
	if err != nil {
		return err
	}
	writeJSON(w, 202, map[string]any{"submission_id": sub.ID, "status": sub.Status})
	return nil
}

func (s *Server) getRun(w http.ResponseWriter, r *http.Request, p app.Principal) error {
	id, err := pathUUID(r, "runId")
	if err != nil {
		return err
	}
	tenant, err := tenantParam(r)
	if err != nil {
		return err
	}
	wait, _ := strconv.Atoi(r.URL.Query().Get("wait"))
	run, cases, err := s.API.GetRun(r.Context(), p, tenant, id, time.Duration(min(max(wait, 0), 10))*time.Second)
	if err != nil {
		return err
	}
	view := map[string]any{
		"run_id": run.ID, "session_id": run.SessionID, "question_id": run.QuestionID, "status": run.Status, "stdout": run.RunStdout, "stderr": run.RunStderr,
		"compile_output": run.CompileOutput, "time_ms": run.MaxCPUms, "memory_kb": run.MaxMemoryKB,
		"cases": caseViews(cases, false),
	}
	writeJSON(w, 200, view)
	return nil
}

func (s *Server) getSubmission(w http.ResponseWriter, r *http.Request, p app.Principal) error {
	id, err := pathUUID(r, "submissionId")
	if err != nil {
		return err
	}
	tenant, err := tenantParam(r)
	if err != nil {
		return err
	}
	staff := r.URL.Query().Get("view") == "staff"
	sub, cases, err := s.API.GetSubmission(r.Context(), p, tenant, id, staff)
	if err != nil {
		return err
	}
	lang := ""
	if langs, err := s.API.Languages(r.Context()); err == nil {
		for _, l := range langs {
			if l.ID == sub.LanguageID {
				lang = l.Slug
			}
		}
	}
	view := map[string]any{
		"submission_id": sub.ID, "session_id": sub.SessionID, "question_id": sub.QuestionID, "language": lang,
		"status": sub.Status, "tests_passed": sub.TestsPassed, "tests_total": sub.TestsTotal,
		"score_ratio": sub.ScoreRatio, "compile_output": sub.CompileOutput, "max_cpu_time_ms": sub.MaxCPUms,
		"max_memory_kb": sub.MaxMemoryKB, "queued_at": sub.QueuedAt, "finished_at": sub.FinishedAt,
		"cases": caseViews(cases, staff),
	}
	if staff {
		view["similarity_max"] = sub.SimilarityMax
		view["similar_submission_id"] = sub.SimilarID
		view["source"] = sub.Source
	}
	writeJSON(w, 200, view)
	return nil
}

// caseViews: hidden tests show pass/fail only to candidates (PRD §2.2b); staff see metrics and
// output excerpts. Hidden inputs and expected outputs are never returned to anyone.
func caseViews(cases []domain.CaseResult, staff bool) []map[string]any {
	out := make([]map[string]any, 0, len(cases))
	for i, c := range cases {
		v := map[string]any{"ordinal": i + 1, "hidden": c.Hidden, "passed": c.Verdict == domain.Accepted}
		if !c.Hidden || staff {
			v["verdict"], v["time_ms"], v["memory_kb"], v["stdout"] = c.Verdict, c.CPUms, c.MemoryKB, c.Stdout
			if c.Detail != "" {
				v["detail"] = c.Detail
			}
		}
		out = append(out, v)
	}
	return out
}
