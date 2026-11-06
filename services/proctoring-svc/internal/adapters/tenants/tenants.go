// Package tenants reads tenant retention from tenant-svc (GET /v1/tenants/{id}/settings, scope
// tenant-settings:read), cached per tenant and invalidated by settings_updated events.
package tenants

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"
)

// DefaultFrameDays applies when tenant-svc has no value (PRD §2.3d: 30 days).
const DefaultFrameDays = 30

// TokenSource returns a service token.
type TokenSource func(ctx context.Context) (string, error)

// Retention is an app.Retention backed by tenant-svc.
type Retention struct {
	BaseURL string
	Token   TokenSource
	HTTP    *http.Client
	TTL     time.Duration

	mu    sync.Mutex
	cache map[string]entry
}

type entry struct {
	days  int
	until time.Time
}

// FrameDays returns the tenant's proctoring_frames_days.
func (r *Retention) FrameDays(ctx context.Context, tenantID string) (int, error) {
	r.mu.Lock()
	if e, ok := r.cache[tenantID]; ok && time.Now().Before(e.until) {
		r.mu.Unlock()
		return e.days, nil
	}
	r.mu.Unlock()
	token, err := r.Token(ctx)
	if err != nil {
		return 0, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(r.BaseURL, "/")+"/v1/tenants/"+tenantID+"/settings", nil)
	if err != nil {
		return 0, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	client := r.HTTP
	if client == nil {
		client = &http.Client{Timeout: 5 * time.Second}
	}
	res, err := client.Do(req)
	if err != nil {
		return 0, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return 0, fmt.Errorf("tenant-svc: HTTP %d", res.StatusCode)
	}
	var body struct {
		RetentionPolicy struct {
			ProctoringFramesDays int `json:"proctoring_frames_days"`
		} `json:"retention_policy"`
	}
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		return 0, err
	}
	days := body.RetentionPolicy.ProctoringFramesDays
	if days <= 0 {
		days = DefaultFrameDays
	}
	ttl := r.TTL
	if ttl == 0 {
		ttl = 10 * time.Minute
	}
	r.mu.Lock()
	if r.cache == nil {
		r.cache = map[string]entry{}
	}
	r.cache[tenantID] = entry{days: days, until: time.Now().Add(ttl)}
	r.mu.Unlock()
	return days, nil
}

// Invalidate drops a tenant's cached value.
func (r *Retention) Invalidate(tenantID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.cache, tenantID)
}

// Static is a fixed retention (tests and local runs).
type Static struct {
	Days        map[string]int
	Invalidated []string
	mu          sync.Mutex
}

func (s *Static) FrameDays(_ context.Context, tenantID string) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if d, ok := s.Days[tenantID]; ok {
		return d, nil
	}
	return DefaultFrameDays, nil
}

func (s *Static) Invalidate(tenantID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.Invalidated = append(s.Invalidated, tenantID)
}
