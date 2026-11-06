package crypto

import (
	"bytes"
	"testing"
)

func TestAESGCM(t *testing.T) {
	c, err := NewAESGCM(bytes.Repeat([]byte{1}, 32))
	if err != nil {
		t.Fatal(err)
	}
	sealed, err := c.Seal([]byte("secret"), "hmac:s1:1")
	if err != nil || bytes.Contains(sealed, []byte("secret")) {
		t.Fatal("not encrypted")
	}
	again, _ := c.Seal([]byte("secret"), "hmac:s1:1")
	if bytes.Equal(sealed, again) {
		t.Fatal("nonces must differ")
	}
	if plain, err := c.Open(sealed, "hmac:s1:1"); err != nil || string(plain) != "secret" {
		t.Fatal(err)
	}
	if _, err := c.Open(sealed, "hmac:s2:1"); err == nil {
		t.Fatal("a value sealed for one session opened for another")
	}
	tampered := append([]byte(nil), sealed...)
	tampered[len(tampered)-1] ^= 1
	if _, err := c.Open(tampered, "hmac:s1:1"); err == nil {
		t.Fatal("tampering not detected")
	}
	if _, err := c.Open([]byte{9, 9}, ""); err == nil {
		t.Fatal("short value")
	}
	if _, err := NewAESGCM([]byte("short")); err == nil {
		t.Fatal("short key")
	}
}
