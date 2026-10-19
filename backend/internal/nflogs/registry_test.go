package nflogs

import (
	"os"
	"path/filepath"
	"testing"
)

func TestRegistryScansOnlyRegularLogFiles(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "amfd.log"), []byte("line\n"), 0o600); err != nil {
		t.Fatalf("write log: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "notes.txt"), []byte("nope\n"), 0o600); err != nil {
		t.Fatalf("write txt: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, ".hidden.log"), []byte("nope\n"), 0o600); err != nil {
		t.Fatalf("write hidden: %v", err)
	}
	if err := os.Mkdir(filepath.Join(dir, "nested.log"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	// A symlink could point at any file the process can read, so it is not a
	// source even when it ends in .log.
	target := filepath.Join(dir, "outside.txt")
	if err := os.WriteFile(target, []byte("secret\n"), 0o600); err != nil {
		t.Fatalf("write target: %v", err)
	}
	if err := os.Symlink(target, filepath.Join(dir, "linked.log")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}

	registry, err := NewRegistry(dir, "", "")
	if err != nil {
		t.Fatalf("registry: %v", err)
	}
	sources := registry.List()
	if len(sources) != 1 {
		t.Fatalf("want one source, got %#v", sources)
	}
	if sources[0].SourceID != "amfd" || sources[0].Name != "amfd.log" {
		t.Fatalf("unexpected source: %#v", sources[0])
	}
	if !sources[0].Readable || sources[0].SizeBytes == 0 {
		t.Fatalf("a readable file must report its size: %#v", sources[0])
	}
}

func TestRegistryResolvesExplicitSourcesAndBindings(t *testing.T) {
	path := filepath.Join(t.TempDir(), "custom.log")
	if err := os.WriteFile(path, []byte("line\n"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}

	registry, err := NewRegistry("", "amf="+path, "amf=resource-1|resource-2")
	if err != nil {
		t.Fatalf("registry: %v", err)
	}
	resolved, ok := registry.Resolve("amf")
	if !ok || resolved.Path != path {
		t.Fatalf("explicit source must resolve: %#v %v", resolved, ok)
	}

	if _, ok := registry.Resolve("../etc/passwd"); ok {
		t.Fatal("a path-like id must never resolve")
	}
	if _, ok := registry.Resolve("unknown"); ok {
		t.Fatal("an unregistered id must not resolve")
	}

	bound := registry.SourcesForResource("resource-2")
	if len(bound) != 1 || bound[0].SourceID != "amf" {
		t.Fatalf("explicit binding must match: %#v", bound)
	}
	if len(registry.SourcesForResource("resource-9")) != 0 {
		t.Fatal("an unbound resource must not match by name")
	}
}

func TestRegistryRejectsMalformedConfiguration(t *testing.T) {
	path := filepath.Join(t.TempDir(), "custom.log")
	if err := os.WriteFile(path, []byte("line\n"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}

	cases := map[string][2]string{
		"relative path":  {"", "amf=custom.log"},
		"uppercase id":   {"", "AMF=" + path},
		"missing equals": {"", "amf"},
		"duplicate id":   {"", "amf=" + path + ",amf=" + path},
		"bad binding":    {"amf=" + path, "amf"},
	}
	for name, fixture := range cases {
		if _, err := NewRegistry(fixture[0], fixture[1], ""); err == nil {
			t.Fatalf("%s must be rejected", name)
		}
	}
}

func TestRegistryReportsUnreadableSources(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "gone.log")
	registry, err := NewRegistry("", "gone="+missing, "")
	if err != nil {
		t.Fatalf("registry: %v", err)
	}
	sources := registry.List()
	if len(sources) != 1 {
		t.Fatalf("a configured but missing file stays listed: %#v", sources)
	}
	if sources[0].Readable {
		t.Fatal("a missing file is not readable")
	}
	if sources[0].Note == "" {
		t.Fatal("an unreadable source must explain itself")
	}
}
