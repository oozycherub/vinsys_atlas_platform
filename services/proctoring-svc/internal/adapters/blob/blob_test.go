package blob

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestS3PresignsOffline(t *testing.T) {
	s, err := NewS3("127.0.0.1:9000", "key", "secret", "atlas-proctoring", "", false)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	up, err := s.PresignUpload(ctx, "t/x/proctor/s/f.jpg", "image/jpeg", 512<<10, 15*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(up.URL, "atlas-proctoring") || up.Fields["key"] != "t/x/proctor/s/f.jpg" || up.Fields["Content-Type"] != "image/jpeg" || up.Fields["policy"] == "" {
		t.Fatalf("upload %+v", up)
	}
	get, err := s.PresignGet(ctx, "t/x/evidence/s/f.jpg", 15*time.Minute)
	if err != nil || !strings.Contains(get, "X-Amz-Expires=900") {
		t.Fatalf("get %s %v", get, err)
	}
	if _, err := NewS3("bad host:x:y", "k", "s", "b", "eu-west-1", true); err == nil {
		t.Fatal("bad endpoint accepted")
	}
}

func TestMemory(t *testing.T) {
	m := NewMemory()
	ctx := context.Background()
	m.Put("t/a/proctor/s/1.jpg", []byte("x"))
	m.Put("t/a/proctor/s/2.jpg", []byte("y"))
	m.Put("t/b/proctor/s/1.jpg", []byte("z"))
	if err := m.Copy(ctx, "t/a/proctor/s/1.jpg", "t/a/evidence/s/1.jpg"); err != nil {
		t.Fatal(err)
	}
	if err := m.DeletePrefix(ctx, "t/a/proctor/"); err != nil {
		t.Fatal(err)
	}
	if err := m.Delete(ctx, []string{"t/b/proctor/s/1.jpg"}); err != nil {
		t.Fatal(err)
	}
	if keys := m.Keys(); len(keys) != 1 || keys[0] != "t/a/evidence/s/1.jpg" {
		t.Fatalf("keys %v", keys)
	}
	m.Fail = true
	if m.Copy(ctx, "a", "b") == nil {
		t.Fatal("fail switch")
	}
	up, _ := m.PresignUpload(ctx, "k", "image/jpeg", 10, time.Minute)
	url, _ := m.PresignGet(ctx, "k", time.Minute)
	if up.Fields["key"] != "k" || !strings.HasPrefix(url, "memory://get/k") {
		t.Fatal("memory presign")
	}
}
