package auth

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// ClientCredentials fetches service tokens from identity-svc (OAuth client credentials) and
// caches them until a minute before they expire, like @atlas/platform's provider.
type ClientCredentials struct {
	TokenURL     string
	ClientID     string
	ClientSecret string
	Scopes       []string
	HTTP         *http.Client
	Now          func() time.Time

	mu    sync.Mutex
	token string
	until time.Time
}

// Token returns a valid bearer token.
func (c *ClientCredentials) Token(ctx context.Context) (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := time.Now()
	if c.Now != nil {
		now = c.Now()
	}
	if c.token != "" && now.Before(c.until) {
		return c.token, nil
	}
	form := url.Values{"grant_type": {"client_credentials"}, "scope": {strings.Join(c.Scopes, " ")}}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.TokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.SetBasicAuth(url.QueryEscape(c.ClientID), url.QueryEscape(c.ClientSecret))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	client := c.HTTP
	if client == nil {
		client = &http.Client{Timeout: 5 * time.Second}
	}
	res, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return "", fmt.Errorf("token request failed with HTTP %d", res.StatusCode)
	}
	var body struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
	}
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil || body.AccessToken == "" {
		return "", fmt.Errorf("the token response has no access_token")
	}
	ttl := body.ExpiresIn
	if ttl <= 0 {
		ttl = 300
	}
	c.token, c.until = body.AccessToken, now.Add(time.Duration(max(0, ttl-60))*time.Second)
	return c.token, nil
}
