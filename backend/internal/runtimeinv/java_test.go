package runtimeinv

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// fixedTime is a deterministic instant shared by the scanner tests.
func fixedTime() time.Time {
	return time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
}

func TestJavaLaunchIdentityVerified(t *testing.T) {
	cases := [][]string{
		{"java", "-jar", "/opt/ims/hss/FHoSS.jar"},
		{"java", "-cp", "/opt/ims/HSSContainer/lib/*", "com.example.Main"},
		{"java", "-Xmx2g", "imsHss"},
		{"java", "/opt/fhoss/FHoSS"},
	}
	for _, argv := range cases {
		match := matchJavaLaunchIdentity(argv)
		if !match.Verified {
			t.Fatalf("argv %v must verify, got %+v", argv, match)
		}
		if match.Token == "" {
			t.Fatalf("argv %v must report the approved token", argv)
		}
	}
}

func TestJavaLaunchIdentityRejectsIncidentalToken(t *testing.T) {
	cases := [][]string{
		{"java", "-Dnote=FHoSS", "-jar", "/opt/app/unrelated.jar"},
		{"java", "-Dservice.imsHss=true", "/opt/app/unrelated.jar"},
		{"java", "-Dname=HSSContainer", "com.example.Other"},
	}
	for _, argv := range cases {
		match := matchJavaLaunchIdentity(argv)
		if match.Verified {
			t.Fatalf("argv %v must not verify", argv)
		}
		if !match.Matched {
			t.Fatalf("argv %v must be reported as an ambiguous candidate", argv)
		}
		if match.Reason != ReasonTokenNotLaunchIdentity {
			t.Fatalf("argv %v must report the launch-position reason, got %s", argv, match.Reason)
		}
	}
}

func TestJavaLaunchIdentityRejectsNearMissTokens(t *testing.T) {
	cases := [][]string{
		{"java", "/opt/app/HSSContainerManagerHelper"},
		{"java", "/opt/app/FHoSS-test-notes.jar"},
		{"java", "com.example.imsHssClient"},
	}
	for _, argv := range cases {
		match := matchJavaLaunchIdentity(argv)
		if match.Matched || match.Verified {
			t.Fatalf("argv %v must not match an approved token, got %+v", argv, match)
		}
	}
}

func TestJavaLaunchIdentityWithoutArguments(t *testing.T) {
	match := matchJavaLaunchIdentity([]string{"java"})
	if match.Matched || match.Verified {
		t.Fatalf("an empty command line must not match, got %+v", match)
	}
	if match.Reason != ReasonCommandUnreadable {
		t.Fatalf("expected the unreadable reason, got %s", match.Reason)
	}
}

func TestScannerJavaHSSCandidates(t *testing.T) {
	f := newFixture(t)
	clock := &fakeClock{now: fixedTime()}
	// A verified IMS HSS launch identity.
	f.process(1101, "java", "/usr/bin/java", 1, 0, 100, 200, []string{"java", "-jar", "/opt/ims/FHoSS.jar"})
	// An unrelated java process.
	f.process(1102, "java", "/usr/bin/java", 2, 0, 100, 200, []string{"java", "-jar", "/opt/app/unrelated.jar"})
	// An incidental token in an option: ambiguous, never verified.
	f.process(1103, "java", "/usr/bin/java", 3, 0, 100, 200, []string{"java", "-Dnote=FHoSS", "-jar", "/opt/app/unrelated.jar"})

	scanner := newTestScanner(f, clock)
	snapshot, _ := scanner.Scan(t.Context(), TriggerManual, nil)
	imsHss := observationFor(t, snapshot, "imsHss")

	if imsHss.RuntimeStatus != StatusRunning {
		t.Fatalf("the verified IMS HSS must be running, got %s", imsHss.RuntimeStatus)
	}
	if imsHss.PrimaryPID != 1101 {
		t.Fatalf("the verified IMS HSS must be pid 1101, got %d", imsHss.PrimaryPID)
	}
	if imsHss.WorkerCount != 1 {
		t.Fatalf("unrelated java processes must not become workers, got %d", imsHss.WorkerCount)
	}
	if imsHss.Monitoring.State != MonitoringNotSupported {
		t.Fatal("IMS HSS monitoring must stay not_supported")
	}
}

func TestScannerJavaUnreadableCommandLine(t *testing.T) {
	f := newFixture(t)
	clock := &fakeClock{now: fixedTime()}
	// comm and executable match java, but the command line cannot be read.
	f.processNoStatus(1201, "java", "/usr/bin/java", 1)
	scanner := newTestScanner(f, clock)
	snapshot, _ := scanner.Scan(t.Context(), TriggerManual, nil)

	imsHss := observationFor(t, snapshot, "imsHss")
	if imsHss.RuntimeStatus != StatusUnverified {
		t.Fatalf("an unreadable command line must stay unverified, got %s", imsHss.RuntimeStatus)
	}
	if imsHss.StatusReason != ReasonCommandUnreadable {
		t.Fatalf("expected the unreadable reason, got %s", imsHss.StatusReason)
	}
}

func TestScannerNeverExposesRawCommandLine(t *testing.T) {
	f := newFixture(t)
	clock := &fakeClock{now: fixedTime()}
	secret := "/opt/ims/FHoSS.jar?token=supersecret"
	f.process(1301, "java", "/usr/bin/java", 1, 0, 10, 10, []string{"java", "-jar", secret})
	scanner := newTestScanner(f, clock)
	snapshot, _ := scanner.Scan(t.Context(), TriggerManual, nil)

	encoded, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if strings.Contains(string(encoded), "supersecret") {
		t.Fatal("the raw command line must never be returned")
	}
	if strings.Contains(string(encoded), "-D") {
		t.Fatal("raw java options must never be returned")
	}
}

func TestJavaTokensAreServerOwned(t *testing.T) {
	tokens := ApprovedJavaTokens()
	if len(tokens) != 3 {
		t.Fatalf("expected the three reviewed CNMS tokens, got %v", tokens)
	}
	tokens[0] = "mutated"
	if ApprovedJavaTokens()[0] == "mutated" {
		t.Fatal("the approved token list must not be mutable through its accessor")
	}
}
