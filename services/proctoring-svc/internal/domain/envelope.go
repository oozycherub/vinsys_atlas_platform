// Package domain holds proctoring rules: the signed event envelope, clock correction, the rules
// engine and the Trust Score (PRD §2.3). It imports only the standard library.
package domain

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

// Canonical serialises a decoded JSON value (decoded with UseNumber) the way the SDK does:
// keys sorted by UTF-16 code units, no whitespace, strings escaped exactly like JSON.stringify,
// numbers re-emitted as received (ADR-0007).
func Canonical(v any) ([]byte, error) {
	var b bytes.Buffer
	if err := canonical(&b, v); err != nil {
		return nil, err
	}
	return b.Bytes(), nil
}

func canonical(b *bytes.Buffer, v any) error {
	switch x := v.(type) {
	case nil:
		b.WriteString("null")
	case bool:
		if x {
			b.WriteString("true")
		} else {
			b.WriteString("false")
		}
	case json.Number:
		b.WriteString(x.String())
	case string:
		writeString(b, x)
	case []any:
		b.WriteByte('[')
		for i, e := range x {
			if i > 0 {
				b.WriteByte(',')
			}
			if err := canonical(b, e); err != nil {
				return err
			}
		}
		b.WriteByte(']')
	case map[string]any:
		keys := make([]string, 0, len(x))
		for k := range x {
			keys = append(keys, k)
		}
		sort.Slice(keys, func(i, j int) bool { return utf16Less(keys[i], keys[j]) })
		b.WriteByte('{')
		for i, k := range keys {
			if i > 0 {
				b.WriteByte(',')
			}
			writeString(b, k)
			b.WriteByte(':')
			if err := canonical(b, x[k]); err != nil {
				return err
			}
		}
		b.WriteByte('}')
	default:
		return fmt.Errorf("canonical: unsupported type %T (decode with UseNumber)", v)
	}
	return nil
}

// utf16Less orders strings by UTF-16 code units, as JavaScript's default sort does.
func utf16Less(a, b string) bool {
	ua, ub := utf16.Encode([]rune(a)), utf16.Encode([]rune(b))
	for i := 0; i < len(ua) && i < len(ub); i++ {
		if ua[i] != ub[i] {
			return ua[i] < ub[i]
		}
	}
	return len(ua) < len(ub)
}

// writeString escapes like JSON.stringify: \" \\ \b \f \n \r \t, other controls as \u00xx
// (lowercase hex), everything else literal (including U+2028/2029).
func writeString(b *bytes.Buffer, s string) {
	b.WriteByte('"')
	for i := 0; i < len(s); {
		r, size := utf8.DecodeRuneInString(s[i:])
		switch {
		case r == '"':
			b.WriteString(`\"`)
		case r == '\\':
			b.WriteString(`\\`)
		case r == '\b':
			b.WriteString(`\b`)
		case r == '\f':
			b.WriteString(`\f`)
		case r == '\n':
			b.WriteString(`\n`)
		case r == '\r':
			b.WriteString(`\r`)
		case r == '\t':
			b.WriteString(`\t`)
		case r < 0x20:
			fmt.Fprintf(b, `\u%04x`, r)
		default:
			b.WriteString(s[i : i+size])
		}
		i += size
	}
	b.WriteByte('"')
}

// Event types the SDK sends (PRD §2.3b, plus device_lost and clock samples via heartbeat).
var EventTypes = map[string]bool{
	"tab_hidden": true, "fullscreen_exit": true, "paste": true, "copy": true, "cut": true, "context_menu": true,
	"multi_monitor": true, "face_count": true, "frame": true, "voice_activity": true, "heartbeat": true,
	"automation_suspected": true, "network_offline": true, "device_lost": true, "keystroke_summary": true,
}

// ClientEvent is one verified envelope.
type ClientEvent struct {
	SessionID string
	Seq       int64
	Type      string
	ClientTs  float64 // ms since the epoch (client clock)
	KeyEpoch  int
	Payload   map[string]any
	PrevHash  string
	MAC       string
	Hash      string // hex sha256 of the canonical envelope including mac: the next prev_hash
}

// Envelope problems. A bad MAC means the event is not trusted at all; a broken chain means
// events were suppressed or reordered (tamper_suspected), but the event itself is authentic.
var (
	ErrMalformed = errors.New("malformed event")
	ErrBadMAC    = errors.New("bad mac")
)

// ParseEnvelope decodes one raw event and checks its MAC with keyFor(epoch). It does not check
// the chain (that needs the session's last hash).
func ParseEnvelope(raw json.RawMessage, sessionID string, keyFor func(epoch int) ([]byte, bool)) (ClientEvent, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var m map[string]any
	if err := dec.Decode(&m); err != nil {
		return ClientEvent{}, fmt.Errorf("%w: %w", ErrMalformed, err)
	}
	e := ClientEvent{}
	var ok bool
	if e.SessionID, ok = m["session_id"].(string); !ok || e.SessionID != sessionID {
		return e, fmt.Errorf("%w: session_id", ErrMalformed)
	}
	seq, err := num(m["seq"])
	if err != nil || seq < 1 || seq != float64(int64(seq)) {
		return e, fmt.Errorf("%w: seq", ErrMalformed)
	}
	e.Seq = int64(seq)
	if e.Type, ok = m["type"].(string); !ok || !EventTypes[e.Type] {
		return e, fmt.Errorf("%w: type", ErrMalformed)
	}
	if e.ClientTs, err = num(m["client_ts"]); err != nil || e.ClientTs <= 0 {
		return e, fmt.Errorf("%w: client_ts", ErrMalformed)
	}
	epoch, err := num(m["key_epoch"])
	if err != nil || epoch < 1 {
		return e, fmt.Errorf("%w: key_epoch", ErrMalformed)
	}
	e.KeyEpoch = int(epoch)
	if e.Payload, ok = m["payload"].(map[string]any); !ok {
		return e, fmt.Errorf("%w: payload", ErrMalformed)
	}
	if e.PrevHash, ok = m["prev_hash"].(string); !ok {
		return e, fmt.Errorf("%w: prev_hash", ErrMalformed)
	}
	if e.MAC, ok = m["mac"].(string); !ok {
		return e, fmt.Errorf("%w: mac", ErrMalformed)
	}
	full, err := Canonical(m)
	if err != nil {
		return e, fmt.Errorf("%w: %w", ErrMalformed, err)
	}
	sum := sha256.Sum256(full)
	e.Hash = hex.EncodeToString(sum[:])
	delete(m, "mac")
	unsigned, _ := Canonical(m)
	key, known := keyFor(e.KeyEpoch)
	if !known || !hmac.Equal([]byte(strings.ToLower(e.MAC)), []byte(Sign(key, unsigned))) {
		return e, ErrBadMAC
	}
	return e, nil
}

// Sign returns hex(HMAC-SHA256(key, data)).
func Sign(key, data []byte) string {
	m := hmac.New(sha256.New, key)
	m.Write(data)
	return hex.EncodeToString(m.Sum(nil))
}

func num(v any) (float64, error) {
	n, ok := v.(json.Number)
	if !ok {
		return 0, errors.New("not a number")
	}
	return n.Float64()
}

// Number reads a numeric payload field (json.Number), or 0.
func Number(payload map[string]any, key string) float64 {
	f, _ := num(payload[key])
	return f
}
