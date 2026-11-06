// Package blob stores test-case bundles in object storage and caches them on the worker node.
package blob

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"

	"atlas.dev/sandbox-svc/internal/app"
	"atlas.dev/sandbox-svc/internal/domain"
)

// S3 is an S3-compatible store (AWS S3 in production, MinIO locally).
type S3 struct {
	client *minio.Client
	bucket string
}

// NewS3 connects to endpoint (host:port) with static credentials.
func NewS3(endpoint, accessKey, secretKey, bucket string, secure bool) (*S3, error) {
	c, err := minio.New(endpoint, &minio.Options{Creds: credentials.NewStaticV4(accessKey, secretKey, ""), Secure: secure})
	if err != nil {
		return nil, err
	}
	return &S3{client: c, bucket: bucket}, nil
}

// Put writes an object with server-side encryption requested by the bucket policy.
func (s *S3) Put(ctx context.Context, key string, data []byte) error {
	_, err := s.client.PutObject(ctx, s.bucket, key, bytes.NewReader(data), int64(len(data)),
		minio.PutObjectOptions{ContentType: "application/json"})
	return err
}

// Get reads an object (at most MaxBundleBytes).
func (s *S3) Get(ctx context.Context, key string) ([]byte, error) {
	obj, err := s.client.GetObject(ctx, s.bucket, key, minio.GetObjectOptions{})
	if err != nil {
		return nil, err
	}
	defer obj.Close()
	data, err := io.ReadAll(io.LimitReader(obj, domain.MaxBundleBytes*2+1))
	if err != nil {
		var resp minio.ErrorResponse
		if errors.As(err, &resp) && resp.Code == "NoSuchKey" {
			return nil, app.ErrNotFound
		}
	}
	return data, err
}

// Delete removes objects; missing keys are ignored.
func (s *S3) Delete(ctx context.Context, keys []string) error {
	for _, k := range keys {
		if err := s.client.RemoveObject(ctx, s.bucket, k, minio.RemoveObjectOptions{}); err != nil {
			return err
		}
	}
	return nil
}

// Memory is an in-process store for tests and local runs.
type Memory struct {
	mu   sync.Mutex
	data map[string][]byte
	// Gets counts reads (tests assert the node cache works).
	Gets int
}

// NewMemory returns an empty store.
func NewMemory() *Memory { return &Memory{data: map[string][]byte{}} }

func (m *Memory) Put(_ context.Context, key string, data []byte) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.data[key] = append([]byte(nil), data...)
	return nil
}

func (m *Memory) Get(_ context.Context, key string) ([]byte, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.Gets++
	d, ok := m.data[key]
	if !ok {
		return nil, app.ErrNotFound
	}
	return append([]byte(nil), d...), nil
}

func (m *Memory) Delete(_ context.Context, keys []string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, k := range keys {
		delete(m.data, k)
	}
	return nil
}

// Keys lists stored keys (tests).
func (m *Memory) Keys() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []string
	for k := range m.data {
		out = append(out, k)
	}
	return out
}

// Cache keeps bundles on the node's disk, addressed by checksum, and verifies every byte it
// serves against the checksum recorded in Postgres (a tampered object is never used).
type Cache struct {
	Store app.BlobStore
	Dir   string
	mu    sync.Mutex
}

// Load returns the bundle content for key, checking it against checksum.
func (c *Cache) Load(ctx context.Context, key string, checksum [32]byte) (domain.BundleContent, error) {
	name := filepath.Join(c.Dir, hex.EncodeToString(checksum[:])+".json")
	c.mu.Lock()
	data, err := os.ReadFile(name)
	c.mu.Unlock()
	if err != nil || sha256.Sum256(data) != checksum {
		if data, err = c.Store.Get(ctx, key); err != nil {
			return domain.BundleContent{}, err
		}
		if sha256.Sum256(data) != checksum {
			return domain.BundleContent{}, fmt.Errorf("bundle %s does not match its checksum", key)
		}
		c.mu.Lock()
		if err := os.MkdirAll(c.Dir, 0o700); err == nil {
			tmp := name + ".tmp"
			if os.WriteFile(tmp, data, 0o600) == nil {
				_ = os.Rename(tmp, name)
			}
		}
		c.mu.Unlock()
	}
	var b domain.BundleContent
	if err := json.Unmarshal(data, &b); err != nil {
		return domain.BundleContent{}, err
	}
	return b, nil
}
