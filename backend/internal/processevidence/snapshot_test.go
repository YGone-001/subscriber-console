//go:build linux

package processevidence

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const testBoot = "11111111-1111-4111-8111-111111111111"

func fixture(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "sys/kernel/random"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "sys/kernel/random/boot_id"), []byte(testBoot), 0o644); err != nil {
		t.Fatal(err)
	}
	return root
}

func processFixture(t *testing.T, root, comm, exe, ticks string) {
	t.Helper()
	dir := filepath.Join(root, "123")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	fields := make([]string, 20)
	for i := range fields {
		fields[i] = "0"
	}
	fields[0], fields[19] = "S", ticks
	if err := os.WriteFile(filepath.Join(dir, "stat"), []byte("123 (name with ) brackets) "+strings.Join(fields, " ")), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "comm"), []byte(comm+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if exe != "" {
		if err := os.Symlink(exe, filepath.Join(dir, "exe")); err != nil {
			t.Fatal(err)
		}
	}
}

func TestCollectOnlyPositiveExactIdentities(t *testing.T) {
	for _, test := range []struct {
		name, comm, exe string
		want            int
	}{
		{"verified", "mmed", "/usr/local/bin/mmed", 1},
		{"masquerade", "mmed", "/tmp/other", 0},
		{"variant", "mmed-test", "/usr/local/bin/mmed", 0},
		{"unreadable", "mmed", "", 0},
		{"deleted", "mmed", "/usr/local/bin/mmed (deleted)", 0},
	} {
		t.Run(test.name, func(t *testing.T) {
			root := fixture(t)
			processFixture(t, root, test.comm, test.exe, "777")
			before, _ := os.ReadFile(filepath.Join(root, "123/stat"))
			snapshot, err := Collect(root, Policy{Names: []string{"mmed"}}, time.Now())
			if err != nil || len(snapshot.Processes) != test.want {
				t.Fatalf("unexpected snapshot: %+v %v", snapshot, err)
			}
			after, _ := os.ReadFile(filepath.Join(root, "123/stat"))
			if string(before) != string(after) {
				t.Fatal("proc fixture changed")
			}
		})
	}
}

func TestReaderRejectsExpiredReusedAndForeignEvidence(t *testing.T) {
	now := time.Now().UTC()
	for _, name := range []string{"valid", "expired", "future", "boot", "pid_reuse", "exe", "name", "missing", "oversized", "trailing"} {
		t.Run(name, func(t *testing.T) {
			root := fixture(t)
			processFixture(t, root, "mmed", "", "777")
			snapshot := Snapshot{Version: 1, BootID: testBoot, ObservedAt: now.Add(-time.Second), Processes: []Process{{Name: "mmed", PID: 123, StartTicks: "777", Executable: "/usr/bin/mmed"}}}
			switch name {
			case "expired":
				snapshot.ObservedAt = now.Add(-MaxAge - time.Second)
			case "future":
				snapshot.ObservedAt = now.Add(time.Second)
			case "boot":
				snapshot.BootID = "22222222-2222-4222-8222-222222222222"
			case "pid_reuse":
				snapshot.Processes[0].StartTicks = "776"
			case "exe":
				snapshot.Processes[0].Executable = "/usr/bin/impostor"
			case "name":
				snapshot.Processes[0].Name = "amfd"
			case "missing":
				snapshot.Processes = nil
			}
			raw, _ := json.Marshal(snapshot)
			if name == "oversized" {
				raw = []byte(strings.Repeat(" ", MaxBytes+1))
			}
			if name == "trailing" {
				raw = append(raw, []byte(" {}")...)
			}
			file := filepath.Join(t.TempDir(), "snapshot.json")
			if err := os.WriteFile(file, raw, 0o644); err != nil {
				t.Fatal(err)
			}
			// Bypass filesystem trust only in this content-validation test. Trust
			// enforcement is independently exercised by the Linux tests below.
			reader := Reader{Path: file, ProcRoot: root, openFile: func(path string, _ uint32) (*os.File, error) { return os.Open(path) }}
			process, observedAt, err := reader.Verify("mmed", 123, now)
			if name == "valid" {
				if err != nil || process.PID != 123 || observedAt != snapshot.ObservedAt {
					t.Fatalf("valid evidence rejected: %v", err)
				}
			} else if err == nil {
				t.Fatalf("%s evidence manufactured success", name)
			}
		})
	}
}

func TestPolicyRejectsCommandLikeAndUnboundedInput(t *testing.T) {
	for _, names := range [][]string{nil, {"mmed", "mmed"}, {"../mmed"}, {"mmed;id"}, {"mmed\n"}, make([]string, 65)} {
		if ValidatePolicy(Policy{Names: names}) == nil {
			t.Fatalf("invalid policy accepted: %q", names)
		}
	}
}

func TestSnapshotReaderDefaultRejectsUntrustedTree(t *testing.T) {
	path := filepath.Join(t.TempDir(), "snapshot.json")
	if err := os.WriteFile(path, []byte(`{}`), 0o644); err != nil {
		t.Fatal(err)
	}
	// /tmp and its descendants are not a root-controlled evidence hierarchy.
	if _, _, err := (Reader{Path: path}).Verify("mmed", 123, time.Now()); err == nil {
		t.Fatal("untrusted snapshot accepted")
	}
	link := path + ".link"
	if err := os.Symlink(path, link); err != nil {
		t.Fatal(err)
	}
	if _, err := openTrusted(link, 0); err == nil {
		t.Fatal("symlink accepted")
	}
}
