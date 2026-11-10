package configsnapshots

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

var uuidPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
var labelPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9 ._/-]{0,95}$`)

func sum(data []byte) string { s := sha256.Sum256(data); return hex.EncodeToString(s[:]) }
func ValidID(id string) bool { return uuidPattern.MatchString(id) }

func LoadCatalog(path string) (Catalog, error) {
	if strings.TrimSpace(path) == "" {
		return Catalog{State: "not_configured", Sources: []Source{}}, nil
	}
	data, err := boundedFile(path, 256<<10)
	if err != nil {
		return Catalog{State: "invalid_config", Sources: []Source{}}, fmt.Errorf("configuration manifest is not a bounded regular file")
	}
	return ParseCatalog(data)
}

func ParseCatalog(data []byte) (Catalog, error) {
	out := Catalog{State: "invalid_config", Sources: []Source{}}
	var m Manifest
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	if len(data) > 256<<10 || d.Decode(&m) != nil || d.Decode(new(any)) != io.EOF {
		return out, fmt.Errorf("invalid configuration manifest JSON")
	}
	if !ValidID(m.CollectorID) || len(m.Sources) > MaxSources {
		return out, fmt.Errorf("invalid configuration manifest bounds")
	}
	roots := append([]string{}, m.Roots...)
	if m.Root != "" {
		roots = append(roots, m.Root)
	}
	if len(roots) == 0 || len(roots) > MaxRoots {
		return out, fmt.Errorf("invalid configuration root count")
	}
	for i, root := range roots {
		if !filepath.IsAbs(root) || filepath.Clean(root) != root {
			return out, fmt.Errorf("configuration roots must be clean absolute paths")
		}
		for _, previous := range roots[:i] {
			if root == previous || withinRoot(root, previous) || withinRoot(previous, root) {
				return out, fmt.Errorf("configuration roots must not overlap")
			}
		}
	}
	seen := map[string]bool{}
	paths := map[string]bool{}
	for _, declaration := range m.Sources {
		if !ValidID(declaration.SourceID) || seen[declaration.SourceID] || !labelPattern.MatchString(declaration.Name) || (declaration.ResourceID != "" && !ValidID(declaration.ResourceID)) {
			return out, fmt.Errorf("invalid or duplicate source identity")
		}
		if declaration.Format != "yaml" && declaration.Format != "json" && declaration.Format != "diameter_conf" && declaration.Format != "text" {
			return out, fmt.Errorf("unsupported declared format")
		}
		if declaration.Profile != PolicyVersion && declaration.Profile != "metadata-only-v1" {
			return out, fmt.Errorf("unsupported projection profile")
		}
		if (declaration.Format == "diameter_conf" || declaration.Format == "text") && declaration.Profile != "metadata-only-v1" {
			return out, fmt.Errorf("declared text and Diameter formats require metadata-only projection")
		}
		if declaration.IntervalSeconds != 0 && (declaration.IntervalSeconds < 60 || declaration.IntervalSeconds > 86400) {
			return out, fmt.Errorf("invalid fixed collection interval")
		}
		root := ""
		for _, candidate := range roots {
			if withinRoot(candidate, declaration.Path) {
				root = candidate
				break
			}
		}
		if !filepath.IsAbs(declaration.Path) || filepath.Clean(declaration.Path) != declaration.Path || root == "" || paths[declaration.Path] {
			return out, fmt.Errorf("source must be a unique file within a declared root")
		}
		seen[declaration.SourceID] = true
		paths[declaration.Path] = true
		identity, _ := json.Marshal([]string{m.CollectorID, declaration.SourceID, declaration.Path, declaration.ResourceID, declaration.Format, declaration.Profile})
		out.Sources = append(out.Sources, Source{SourceID: declaration.SourceID, Name: declaration.Name, CollectorID: m.CollectorID, ResourceID: declaration.ResourceID, Format: declaration.Format, Profile: declaration.Profile, Path: declaration.Path, Root: root, Generation: sum(identity), IntervalSeconds: declaration.IntervalSeconds})
	}
	sort.Slice(out.Sources, func(i, j int) bool { return out.Sources[i].SourceID < out.Sources[j].SourceID })
	out.Root = m.Root
	out.State = "configured"
	return out, nil
}

func withinRoot(root, path string) bool {
	rel, err := filepath.Rel(root, path)
	return err == nil && rel != "." && rel != ".." && !filepath.IsAbs(rel) && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

func boundedFile(path string, max int64) ([]byte, error) {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() > max {
		return nil, fmt.Errorf("unreadable regular file")
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("file unavailable")
	}
	defer f.Close()
	opened, err := f.Stat()
	if err != nil || !os.SameFile(info, opened) {
		return nil, fmt.Errorf("file identity changed")
	}
	b, err := io.ReadAll(io.LimitReader(f, max+1))
	if err != nil || int64(len(b)) > max {
		return nil, fmt.Errorf("file exceeds budget")
	}
	return b, nil
}

func LoadKey(path string) ([]byte, error) {
	if path == "" {
		return nil, nil
	}
	info, e := os.Lstat(path)
	if e != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 || !noLinks(path) {
		return nil, fmt.Errorf("fingerprint key must be a private regular file")
	}
	b, e := boundedFile(path, 4096)
	if e != nil {
		return nil, e
	}
	b = bytes.TrimSpace(b)
	if len(b) < 32 {
		return nil, fmt.Errorf("fingerprint key must contain at least 32 bytes")
	}
	return b, nil
}
