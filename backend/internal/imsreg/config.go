package imsreg

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

var keyPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}$`)
var uuidPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
var databasePattern = regexp.MustCompile(`^[A-Za-z0-9_]{1,64}$`)
var passwordPattern = regexp.MustCompile(`^IMS_[A-Z0-9_]+_PASSWORD$`)

func configError() error { return errors.New("invalid IMS source configuration") }

func LoadCatalog(path string) (Catalog, error) {
	if path == "" {
		return Catalog{Version: 1, Sources: []Source{}}, nil
	}
	if !filepath.IsAbs(path) {
		return Catalog{}, configError()
	}
	f, err := os.Open(path)
	if err != nil {
		return Catalog{}, configError()
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, (1<<20)+1))
	if err != nil || len(b) > 1<<20 {
		return Catalog{}, configError()
	}
	return ParseCatalog(b)
}
func ParseCatalog(b []byte) (Catalog, error) {
	var c Catalog
	d := json.NewDecoder(bytes.NewReader(b))
	d.DisallowUnknownFields()
	if d.Decode(&c) != nil || d.Decode(new(any)) != io.EOF || c.Version != 1 || len(c.Sources) > MaxSources {
		return Catalog{}, configError()
	}
	seen, databases := map[string]bool{}, map[string]bool{}
	for _, s := range c.Sources {
		if !keyPattern.MatchString(s.ID) || !keyPattern.MatchString(s.Authority) || !uuidPattern.MatchString(s.ResourceID) || seen[s.ID] || !safeText(s.Name, 128) || s.Name == "" {
			return Catalog{}, configError()
		}
		if s.Persistence != "write_back" && s.Persistence != "memory_only" && s.Persistence != "unknown" {
			return Catalog{}, configError()
		}
		if validateConnection(s.SCSCF) != nil || s.HSS != nil && validateConnection(*s.HSS) != nil {
			return Catalog{}, configError()
		}
		identity := strings.ToLower(s.SCSCF.Address) + "/" + s.SCSCF.Database
		if databases[identity] {
			return Catalog{}, configError()
		}
		seen[s.ID], databases[identity] = true, true
	}
	if c.Sources == nil {
		c.Sources = []Source{}
	}
	return c, nil
}
func validateConnection(c Connection) error {
	host, port, err := net.SplitHostPort(c.Address)
	if err != nil || host == "" || port == "" || strings.ContainsAny(host, "/\\@?# \t\r\n") || !databasePattern.MatchString(c.Database) || !safeText(c.User, 64) || c.User == "" || !passwordPattern.MatchString(c.PasswordEnv) {
		return configError()
	}
	portNumber, err := strconv.Atoi(port)
	if err != nil || portNumber < 1 || portNumber > 65535 {
		return configError()
	}
	ip := net.ParseIP(host)
	local := ip != nil && ip.IsLoopback()
	if !local && (c.CAFile == "" || c.ServerName == "") {
		return configError()
	}
	if c.CAFile != "" && (!filepath.IsAbs(c.CAFile) || c.ServerName == "" || !safeText(c.ServerName, 253)) {
		return configError()
	}
	return nil
}
func safeText(s string, max int) bool {
	return utf8.ValidString(s) && utf8.RuneCountInString(s) <= max && strings.IndexFunc(s, unicode.IsControl) < 0
}
