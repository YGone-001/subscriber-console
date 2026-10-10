package nfhealth

import (
	"crypto/rand"
	"fmt"
)

// newUUID returns a canonical UUID v4 used for server-generated identifiers.
func newUUID() string {
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		panic("nfhealth: crypto/rand failed: " + err.Error())
	}
	buf[6] = (buf[6] & 0x0f) | 0x40
	buf[8] = (buf[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x",
		buf[0:4], buf[4:6], buf[6:8], buf[8:10], buf[10:16])
}
