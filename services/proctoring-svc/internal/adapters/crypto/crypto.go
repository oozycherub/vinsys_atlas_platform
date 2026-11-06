// Package crypto encrypts session HMAC keys and biometric reference embeddings with
// AES-256-GCM (the key comes from the secret manager; KMS envelope encryption in production).
package crypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"errors"
)

// AESGCM is an app.Cipher. Sealed = version byte || nonce || ciphertext; the AAD binds a value to
// its purpose and session, so a sealed key cannot be swapped between sessions.
type AESGCM struct{ aead cipher.AEAD }

// NewAESGCM takes a 32-byte key.
func NewAESGCM(key []byte) (*AESGCM, error) {
	if len(key) != 32 {
		return nil, errors.New("the data key must be 32 bytes")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &AESGCM{aead: aead}, nil
}

const version = 1

// Seal encrypts plain, bound to aad.
func (c *AESGCM) Seal(plain []byte, aad string) ([]byte, error) {
	nonce := make([]byte, c.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	out := append([]byte{version}, nonce...)
	return c.aead.Seal(out, nonce, plain, []byte(aad)), nil
}

// Open decrypts a sealed value; a wrong AAD or any tampering fails.
func (c *AESGCM) Open(sealed []byte, aad string) ([]byte, error) {
	n := c.aead.NonceSize()
	if len(sealed) < 1+n || sealed[0] != version {
		return nil, errors.New("not a sealed value")
	}
	return c.aead.Open(nil, sealed[1:1+n], sealed[1+n:], []byte(aad))
}
