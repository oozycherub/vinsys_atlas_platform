// Package blob is object storage for proctoring frames and evidence: S3 (MinIO locally) with
// presigned POST uploads, and an in-memory store for tests.
package blob

import (
	"context"
	"fmt"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"

	"atlas.dev/proctoring-svc/internal/app"
)

// S3 is an S3-compatible store.
type S3 struct {
	client *minio.Client
	bucket string
}

// NewS3 connects to endpoint (host:port). The region is explicit so presigning needs no
// bucket-location round trip.
func NewS3(endpoint, accessKey, secretKey, bucket, region string, secure bool) (*S3, error) {
	if region == "" {
		region = "us-east-1"
	}
	c, err := minio.New(endpoint, &minio.Options{Creds: credentials.NewStaticV4(accessKey, secretKey, ""), Secure: secure, Region: region})
	if err != nil {
		return nil, err
	}
	return &S3{client: c, bucket: bucket}, nil
}

// PresignUpload returns a POST policy: exact key, exact content type, size ≤ maxBytes.
func (s *S3) PresignUpload(ctx context.Context, key, contentType string, maxBytes int64, ttl time.Duration) (app.Upload, error) {
	policy := minio.NewPostPolicy()
	exp := time.Now().Add(ttl).UTC()
	for _, err := range []error{
		policy.SetBucket(s.bucket), policy.SetKey(key), policy.SetContentType(contentType),
		policy.SetContentLengthRange(1, maxBytes), policy.SetExpires(exp),
	} {
		if err != nil {
			return app.Upload{}, err
		}
	}
	u, fields, err := s.client.PresignedPostPolicy(ctx, policy)
	if err != nil {
		return app.Upload{}, err
	}
	return app.Upload{URL: u.String(), Fields: fields, ExpiresAt: exp}, nil
}

// PresignGet returns a signed GET URL.
func (s *S3) PresignGet(ctx context.Context, key string, ttl time.Duration) (string, error) {
	u, err := s.client.PresignedGetObject(ctx, s.bucket, key, ttl, url.Values{})
	if err != nil {
		return "", err
	}
	return u.String(), nil
}

// Copy copies an object within the bucket.
func (s *S3) Copy(ctx context.Context, src, dst string) error {
	_, err := s.client.CopyObject(ctx, minio.CopyDestOptions{Bucket: s.bucket, Object: dst}, minio.CopySrcOptions{Bucket: s.bucket, Object: src})
	return err
}

// Delete removes objects.
func (s *S3) Delete(ctx context.Context, keys []string) error {
	for _, k := range keys {
		if err := s.client.RemoveObject(ctx, s.bucket, k, minio.RemoveObjectOptions{}); err != nil {
			return err
		}
	}
	return nil
}

// DeletePrefix removes every object under prefix.
func (s *S3) DeletePrefix(ctx context.Context, prefix string) error {
	for obj := range s.client.ListObjects(ctx, s.bucket, minio.ListObjectsOptions{Prefix: prefix, Recursive: true}) {
		if obj.Err != nil {
			return obj.Err
		}
		if err := s.client.RemoveObject(ctx, s.bucket, obj.Key, minio.RemoveObjectOptions{}); err != nil {
			return err
		}
	}
	return nil
}

// Memory is an in-process store for tests.
type Memory struct {
	mu      sync.Mutex
	objects map[string][]byte
	// Fail makes Copy fail (evidence retry tests).
	Fail bool
}

// NewMemory returns an empty store.
func NewMemory() *Memory { return &Memory{objects: map[string][]byte{}} }

// Put stores an object (what a client's upload would do).
func (m *Memory) Put(key string, data []byte) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.objects[key] = data
}

// Keys lists stored keys, sorted.
func (m *Memory) Keys() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]string, 0, len(m.objects))
	for k := range m.objects {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func (m *Memory) PresignUpload(_ context.Context, key, contentType string, maxBytes int64, ttl time.Duration) (app.Upload, error) {
	return app.Upload{URL: "memory://upload", Fields: map[string]string{"key": key, "Content-Type": contentType,
		"max": fmt.Sprint(maxBytes)}, ExpiresAt: time.Now().Add(ttl)}, nil
}

func (m *Memory) PresignGet(_ context.Context, key string, ttl time.Duration) (string, error) {
	return "memory://get/" + key + "?ttl=" + ttl.String(), nil
}

func (m *Memory) Copy(_ context.Context, src, dst string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.Fail {
		return fmt.Errorf("copy failed")
	}
	m.objects[dst] = m.objects[src]
	return nil
}

func (m *Memory) Delete(_ context.Context, keys []string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, k := range keys {
		delete(m.objects, k)
	}
	return nil
}

func (m *Memory) DeletePrefix(_ context.Context, prefix string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for k := range m.objects {
		if strings.HasPrefix(k, prefix) {
			delete(m.objects, k)
		}
	}
	return nil
}
