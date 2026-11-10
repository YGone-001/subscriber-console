package configsnapshots

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestProjectionPositiveAllowlist(t *testing.T) {
	input := []byte("# SYNTHETIC_COMMENT_SECRET\ndb_uri: mongodb://user:SYNTHETIC_DB_SECRET@db/\namf:\n  sbi:\n    server:\n      - address: 127.0.0.5\n        port: 7777\n        password: SYNTHETIC_PASSWORD_SECRET\n    client:\n      nrf:\n        - uri: http://user:SYNTHETIC_URI_SECRET@nrf/\n  security:\n    key: SYNTHETIC_KEY_SECRET\n  SYNTHETIC_KEY_NAME_SECRET: ignored\nlogger:\n  level: info\n")
	mode, _, projection := Projection(input, "yaml", PolicyVersion)
	if mode != "projected" || !strings.Contains(projection, "127.0.0.5") || !strings.Contains(projection, "7777") {
		t.Fatalf("approved fields not projected: %s", mode)
	}
	if strings.Contains(projection, "SYNTHETIC") || strings.Contains(projection, "password") || strings.Contains(projection, "db_uri") {
		t.Fatal("secret reached projection")
	}
	var flat map[string]any
	if json.Unmarshal([]byte(projection), &flat) != nil || len(flat) != 3 {
		t.Fatal("projection contains unapproved fields")
	}
}
func TestAmbiguousDocumentsStayMetadataOnly(t *testing.T) {
	for _, input := range []string{"amf: {sbi: &x {server: {address: 127.0.0.1}}}\nother: *x", "amf: {}\namf: {}", "amf: !custom {}", "amf: {}\n---\nmme: {}", "[1,2,3]", "amf: {unknown: private}", "amf: {sbi: {server: {port: nope}}}"} {
		mode, _, projection := Projection([]byte(input), "yaml", PolicyVersion)
		if mode != "metadata_only" || projection != "" {
			t.Fatal("ambiguous input was exposed")
		}
	}
	mode, _, text := Projection([]byte(`{"amf":{},"amf":{}}`), "json", PolicyVersion)
	if mode != "metadata_only" || text != "" {
		t.Fatal("duplicate JSON key accepted")
	}
	mode, _, text = Projection([]byte("Identity = \"private\";"), "diameter_conf", "metadata-only-v1")
	if mode != "metadata_only" || text != "" {
		t.Fatal("Diameter content exposed")
	}
}
func TestReaderRejectsUnsafeSources(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "amf.yaml")
	if e := os.WriteFile(path, []byte("amf: {}"), 0600); e != nil {
		t.Fatal(e)
	}
	s := Source{Path: path}
	data, reason := readSource(context.Background(), dir, s)
	if reason != "" || string(data) != "amf: {}" {
		t.Fatal("regular file unavailable")
	}
	outside := filepath.Join(t.TempDir(), "outside.yaml")
	_ = os.WriteFile(outside, []byte("secret"), 0600)
	if _, reason = readSource(context.Background(), dir, Source{Path: outside}); reason != "path_rejected" {
		t.Fatal("outside root accepted")
	}
	link := filepath.Join(dir, "link.yaml")
	if e := os.Symlink(path, link); e == nil {
		if _, reason = readSource(context.Background(), dir, Source{Path: link}); reason != "path_rejected" {
			t.Fatal("symlink accepted")
		}
	}
	_ = os.WriteFile(path, []byte{0, 1, 2}, 0600)
	if _, reason = readSource(context.Background(), dir, s); reason != "invalid_encoding" {
		t.Fatal("binary accepted")
	}
	_ = os.WriteFile(path, make([]byte, MaxFileBytes+1), 0600)
	if _, reason = readSource(context.Background(), dir, s); reason != "file_too_large" {
		t.Fatal("oversize accepted")
	}
}
func TestDiffInsertionAndCompatibility(t *testing.T) {
	a := &Snapshot{SourceID: "same", Generation: "g", Policy: PolicyVersion, KeyVersion: "k", Mode: "projected", Fingerprint: "a", ProjectionHash: "a", Projection: "a\nb\nc\n"}
	b := *a
	b.Fingerprint = "b"
	b.ProjectionHash = "b"
	b.Projection = "a\ninserted\nb\nc\n"
	d := BuildDiff(context.Background(), a, &b)
	if !d.Complete || len(d.Lines) != 4 || d.Lines[1].Kind != "add" || d.Lines[2].Kind != "same" {
		t.Fatalf("insertion damaged trailing context: %#v", d)
	}
	b.ProjectionHash = "a"
	if Compare(a, &b) != "unprojected_changed" {
		t.Fatal("hidden change mislabeled")
	}
	b.KeyVersion = "new"
	if Compare(a, &b) != "incompatible" {
		t.Fatal("key rotation created drift")
	}
	b = *a
	b.Generation = "new"
	if Compare(a, &b) != "incompatible" {
		t.Fatal("source retargeting created drift")
	}
}
func TestManifestAndPrivateSerialization(t *testing.T) {
	dir := t.TempDir()
	m := Manifest{CollectorID: randomID(), Root: dir, Sources: []SourceDeclaration{{SourceID: randomID(), Name: "AMF YAML", Path: filepath.Join(dir, "amf.yaml"), Format: "yaml", Profile: PolicyVersion}}}
	b, _ := json.Marshal(m)
	catalog, e := ParseCatalog(b)
	if e != nil || len(catalog.Sources) != 1 {
		t.Fatal(e)
	}
	public, _ := json.Marshal(catalog.Sources)
	if strings.Contains(string(public), dir) {
		t.Fatal("path leaked")
	}
	snap := Snapshot{Fingerprint: "SYNTHETIC_PRIVATE_FINGERPRINT", KeyVersion: "PRIVATE_KEY_VERSION", Projection: "{}", Published: true, CollectedAt: time.Now()}
	public, _ = json.Marshal(snap)
	if strings.Contains(string(public), "SYNTHETIC") || strings.Contains(string(public), "PRIVATE_KEY_VERSION") {
		t.Fatal("internal fingerprint leaked")
	}
	m.Sources = append(m.Sources, m.Sources[0])
	b, _ = json.Marshal(m)
	if _, e = ParseCatalog(b); e == nil {
		t.Fatal("duplicate source accepted")
	}
	m.Sources = m.Sources[:1]
	m.Sources[0].Path = filepath.Join(t.TempDir(), "other")
	b, _ = json.Marshal(m)
	if _, e = ParseCatalog(b); e == nil {
		t.Fatal("out-of-root manifest accepted")
	}
}

func TestMultipleRootsPreserveLegacyIdentityAndConfinement(t *testing.T) {
	epcRoot, imsRoot := t.TempDir(), t.TempDir()
	first := SourceDeclaration{SourceID: randomID(), Name: "EPC YAML", Path: filepath.Join(epcRoot, "amf.yaml"), Format: "yaml", Profile: PolicyVersion}
	m := Manifest{CollectorID: randomID(), Root: epcRoot, Sources: []SourceDeclaration{first}}
	parse := func() (Catalog, error) { data, _ := json.Marshal(m); return ParseCatalog(data) }
	legacy, err := parse()
	if err != nil {
		t.Fatal(err)
	}
	ims := SourceDeclaration{SourceID: randomID(), Name: "IMS PCSCF vars.cfg", Path: filepath.Join(imsRoot, "vars.cfg"), Format: "text", Profile: "metadata-only-v1"}
	m.Roots = []string{imsRoot}
	m.Sources = append(m.Sources, ims)
	catalog, err := parse()
	if err != nil || len(catalog.Sources) != 2 {
		t.Fatal("separate declared roots were rejected")
	}
	for _, source := range catalog.Sources {
		if source.SourceID == first.SourceID && (source.Root != epcRoot || source.Generation != legacy.Sources[0].Generation) {
			t.Fatal("adding IMS roots changed existing source identity")
		}
		if source.SourceID == ims.SourceID && source.Root != imsRoot {
			t.Fatal("IMS source selected another source root")
		}
	}
	public, _ := json.Marshal(catalog.Sources)
	if strings.Contains(string(public), epcRoot) || strings.Contains(string(public), imsRoot) {
		t.Fatal("private filesystem scope reached the API")
	}
	m.Sources[1].Path = filepath.Join(t.TempDir(), "outside.cfg")
	if _, err = parse(); err == nil {
		t.Fatal("undeclared root was accepted")
	}
	m.Sources[1] = ims
	m.Sources[1].Profile = PolicyVersion
	if _, err = parse(); err == nil {
		t.Fatal("opaque IMS text was allowed to enter a content projection")
	}
	m.Sources[1] = ims
	for _, roots := range [][]string{{imsRoot, imsRoot}, {epcRoot}, {filepath.Join(imsRoot, "child"), imsRoot}, {"relative"}} {
		m.Roots = roots
		if _, err = parse(); err == nil {
			t.Fatal("duplicate, overlapping or relative roots were accepted")
		}
	}
	m.Root, m.Roots, m.Sources = "", []string{imsRoot}, []SourceDeclaration{ims}
	if _, err = parse(); err != nil {
		t.Fatal("roots-only declaration was rejected")
	}
	for len(m.Roots) <= MaxRoots {
		m.Roots = append(m.Roots, t.TempDir())
	}
	if _, err = parse(); err == nil {
		t.Fatal("unbounded root list was accepted")
	}
	mode, _, projection := Projection([]byte("password=SYNTHETIC_IMS_SECRET"), "text", PolicyVersion)
	if mode != "metadata_only" || projection != "" {
		t.Fatal("opaque text content reached a projection")
	}
}
