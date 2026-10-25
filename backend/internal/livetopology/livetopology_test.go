package livetopology

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"subscriber/internal/auth"
	"subscriber/internal/runtimeinv"
)

func writeTestFile(t *testing.T, dir, name, content string) string {
	t.Helper()
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("write %s: %v", name, err)
	}
	return path
}

func testSnapshot() *runtimeinv.Snapshot {
	component := func(id, role, domain, status string) runtimeinv.Observation {
		return runtimeinv.Observation{
			ComponentID:   id,
			DisplayName:   id,
			ProcessName:   id + "d",
			Domain:        domain,
			Role:          role,
			NFTType:       role,
			RuntimeStatus: status,
			StatusReason:  "test",
		}
	}
	return &runtimeinv.Snapshot{
		Host: runtimeinv.HostIdentity{HostID: "host-test", HostName: "test-host"},
		Components: []runtimeinv.Observation{
			component("smf", "smf", "5gc", runtimeinv.StatusRunning),
			component("upf", "upf", "5gc", runtimeinv.StatusRunning),
			component("hss", "hss", "epc", runtimeinv.StatusRunning),
			component("icscf", "icscf", "ims", runtimeinv.StatusRunning),
			component("imsHss", "hss", "ims", runtimeinv.StatusRunning),
			component("dra", "dra", "epc", runtimeinv.StatusStopped),
		},
		Counts:      runtimeinv.SnapshotCounts{Total: 6, Running: 5, Stopped: 1},
		GeneratedAt: "2026-10-23T00:00:00Z",
	}
}

func TestManifestLoadAndBuild(t *testing.T) {
	dir := t.TempDir()
	smf := writeTestFile(t, dir, "smf.yaml", `
smf:
  pfcp:
    server:
      - address: 127.0.0.4
    client:
      upf:
        - address: 127.0.0.7
`)
	upf := writeTestFile(t, dir, "upf.yaml", `
upf:
  pfcp:
    server:
      - address: 127.0.0.7
    client:
      smf:
        - address: 127.0.0.4
`)
	hss := writeTestFile(t, dir, "hss.conf", `
Identity = "hss.epc.example";
Port = 3888;
ListenOn = "127.0.0.8";
`)
	icscf := writeTestFile(t, dir, "icscf.xml", `
<DiameterPeer FQDN="icscf.ims.example" Realm="ims.example">
  <Acceptor port="3869" bind="127.0.0.9"/>
  <Peer FQDN="hss.ims.example" Realm="ims.example" port="3868"/>
</DiameterPeer>
`)
	imsHss := writeTestFile(t, dir, "DiameterPeerHSS.xml", `
<DiameterPeer FQDN="hss.ims.example" Realm="ims.example">
  <Acceptor port="3868" bind="127.0.0.8"/>
  <Peer FQDN="icscf.ims.example" port="3869"/>
</DiameterPeer>
`)
	manifest := map[string][]string{
		"smf":    {smf},
		"upf":    {upf},
		"hss":    {hss},
		"icscf":  {icscf},
		"imsHss": {imsHss},
	}
	manifestData, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	manifestPath := writeTestFile(t, dir, "manifest.json", string(manifestData))

	snapshot := testSnapshot()
	ids := map[string]bool{}
	for _, component := range snapshot.Components {
		ids[component.ComponentID] = true
	}
	loader := NewLoader(manifestPath)
	parsed, status := loader.Load(ids)
	if !status.ManifestConfigured || !status.Complete {
		t.Fatalf("manifest should be configured and complete: %+v", status)
	}
	if status.SourceCount != 5 || status.AvailableSources != 5 {
		t.Fatalf("expected five available sources, got %+v", status)
	}

	response := Build(snapshot, parsed, status)
	if len(response.Nodes) != 6 {
		t.Fatalf("expected six runtime nodes, got %d", len(response.Nodes))
	}
	if response.Summary.EdgeCount != 2 {
		t.Fatalf("expected N4 and Cx configured edges, got %d: %+v", response.Summary.EdgeCount, response.Edges)
	}
	interfaces := map[string]string{}
	for _, edge := range response.Edges {
		key := edge.FromComponentID + "->" + edge.ToComponentID
		interfaces[key] = edge.InterfaceNames[0]
		if edge.Evidence != EvidenceConfigured {
			t.Errorf("edge %s must be configured evidence", key)
		}
		if edge.State != EdgeActive {
			t.Errorf("edge %s must be active while both endpoints run", key)
		}
	}
	if interfaces["smf->upf"] != "N4" {
		t.Errorf("expected smf->upf N4, got %+v", interfaces)
	}
	foundCx := false
	for _, edge := range response.Edges {
		if (edge.FromComponentID == "icscf" && edge.ToComponentID == "imsHss") ||
			(edge.FromComponentID == "imsHss" && edge.ToComponentID == "icscf") {
			foundCx = edge.InterfaceNames[0] == "Cx"
		}
	}
	if !foundCx {
		t.Errorf("expected Cx edge between icscf and imsHss, got %+v", response.Edges)
	}
	if response.Runtime.Total != 6 || response.Runtime.Running != 5 || response.Runtime.Stopped != 1 {
		t.Errorf("runtime counts must be preserved: %+v", response.Runtime)
	}
}

func TestEdgeStateNeverClaimsInactiveWithoutEvidence(t *testing.T) {
	cases := []struct {
		from, to, want string
	}{
		{runtimeinv.StatusRunning, runtimeinv.StatusRunning, EdgeActive},
		{runtimeinv.StatusRunning, runtimeinv.StatusStopped, EdgePartial},
		{runtimeinv.StatusRunning, runtimeinv.StatusNotDetected, EdgePartial},
		{runtimeinv.StatusRunning, runtimeinv.StatusPermissionDenied, EdgeUnknown},
		{runtimeinv.StatusStopped, runtimeinv.StatusStopped, EdgeInactive},
		{runtimeinv.StatusStopped, runtimeinv.StatusNotDetected, EdgeUnknown},
		{runtimeinv.StatusPermissionDenied, runtimeinv.StatusPermissionDenied, EdgeUnknown},
		{runtimeinv.StatusUnverified, runtimeinv.StatusStopped, EdgeUnknown},
		{"", "", EdgeUnknown},
	}
	for _, item := range cases {
		if got := statusState(item.from, item.to); got != item.want {
			t.Errorf("statusState(%q, %q) = %q, want %q", item.from, item.to, got, item.want)
		}
	}
}

func TestDRAConfigNeverSynthesizesDirectEdgesOrLeaksSecrets(t *testing.T) {
	dir := t.TempDir()
	dra := writeTestFile(t, dir, "dra.cfg", `
serverPort = 3868;
http2Port = 7777;
mmlPort = 7123;
realm = "epc.mnc003.mcc515.3gppnetwork.org";
password = "supersecret-value";
tlsKey = "/run/secrets/dra.key";
peer = { fqdn = "mme.epc.example"; port = 3868; };
`)
	data, _ := json.Marshal(map[string][]string{"dra": {dra}})
	manifestPath := writeTestFile(t, dir, "manifest.json", string(data))

	snapshot := testSnapshot()
	parsed, status := NewLoader(manifestPath).Load(map[string]bool{"dra": true})
	if !status.Complete {
		t.Fatalf("DRA config must parse as a complete source: %+v", status)
	}
	response := Build(snapshot, parsed, status)
	if len(response.Edges) != 0 {
		t.Fatalf("DRA peer segments must not become direct NF-to-NF edges: %+v", response.Edges)
	}
	var draNode *Node
	for index := range response.Nodes {
		if response.Nodes[index].ComponentID == "dra" {
			draNode = &response.Nodes[index]
		}
	}
	if draNode == nil || len(draNode.Listeners) != 3 {
		t.Fatalf("DRA must expose its configured ports without inventing a bind address: %+v", draNode)
	}
	ports := map[string]int{}
	for _, listener := range draNode.Listeners {
		if listener.Address != "" {
			t.Fatalf("DRA bind address is not configured and must remain empty: %+v", listener)
		}
		ports[listener.Protocol] = listener.Port
	}
	if ports["diameter"] != 3868 || ports["http2"] != 7777 || ports["mml"] != 7123 {
		t.Fatalf("unexpected DRA listener ports: %+v", ports)
	}
	body, err := json.Marshal(response)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{"supersecret-value", "dra.key"} {
		if strings.Contains(string(body), secret) {
			t.Fatalf("live response must not contain config secret material: %s", secret)
		}
	}
}

func TestManifestMissingFileIsReportedNotFatal(t *testing.T) {
	dir := t.TempDir()
	manifest := map[string][]string{"smf": {filepath.Join(dir, "missing.yaml")}}
	data, _ := json.Marshal(manifest)
	manifestPath := writeTestFile(t, dir, "manifest.json", string(data))
	parsed, status := (&Loader{ManifestPath: manifestPath}).Load(map[string]bool{"smf": true})
	if status.Complete {
		t.Fatalf("missing file must make config incomplete: %+v", status)
	}
	if len(status.Unavailable) != 1 {
		t.Fatalf("expected one unavailable source, got %+v", status.Unavailable)
	}
	if len(parsed) != 1 {
		t.Fatalf("component entry must remain present for runtime nodes")
	}
}

func TestManifestNotConfiguredLeavesRuntimeNodes(t *testing.T) {
	parsed, status := NewLoader("").Load(map[string]bool{"smf": true})
	if status.ManifestConfigured || status.Complete {
		t.Fatalf("unset manifest must be reported as not configured: %+v", status)
	}
	response := Build(testSnapshot(), parsed, status)
	if len(response.Nodes) != 6 || len(response.Edges) != 0 {
		t.Fatalf("runtime nodes must remain visible without config: %+v", response)
	}
}

func TestLiveHandlerAuthAndShape(t *testing.T) {
	dir := t.TempDir()
	manifest := map[string][]string{}
	data, _ := json.Marshal(manifest)
	manifestPath := writeTestFile(t, dir, "manifest.json", string(data))
	handler := NewHandler(snapshotProviderFunc(testSnapshot), manifestPath, nil)

	w := httptest.NewRecorder()
	handler.Live(w, httptest.NewRequest(http.MethodGet, "/api/topology/live", nil))
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous live: expected 401, got %d", w.Code)
	}

	w = httptest.NewRecorder()
	req := withPrincipal(httptest.NewRequest(http.MethodGet, "/api/topology/live?bogus=1", nil), "viewer")
	handler.Live(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("unknown query: expected 400, got %d", w.Code)
	}

	w = httptest.NewRecorder()
	handler.Live(w, withPrincipal(httptest.NewRequest(http.MethodGet, "/api/topology/live", nil), "viewer"))
	if w.Code != http.StatusOK {
		t.Fatalf("viewer live: expected 200, got %d (%s)", w.Code, w.Body.String())
	}
	var body Response
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("live body must be JSON: %v", err)
	}
	if len(body.Nodes) != 6 || body.Runtime.Running != 5 {
		t.Fatalf("unexpected live payload: %+v", body)
	}
}

// recordingAssociator stands in for the shared runtime association authority.
type recordingAssociator struct{ calls int }

func (a *recordingAssociator) Attach(_ context.Context, snapshot *runtimeinv.Snapshot) bool {
	a.calls++
	for index := range snapshot.Components {
		if snapshot.Components[index].ComponentID == "smf" {
			snapshot.Components[index].InventoryAssociation = runtimeinv.AssociationProjection{
				State: runtimeinv.AssociationAssociated,
				ID:    "11111111-2222-3333-4444-555555555555",
			}
		}
	}
	return true
}

func TestLiveHandlerAttachesInventoryAssociations(t *testing.T) {
	handler := NewHandler(snapshotProviderFunc(testSnapshot), "", nil)
	associator := &recordingAssociator{}
	handler.SetAssociator(associator)

	w := httptest.NewRecorder()
	handler.Live(w, withPrincipal(httptest.NewRequest(http.MethodGet, "/api/topology/live", nil), "viewer"))
	if w.Code != http.StatusOK {
		t.Fatalf("viewer live: expected 200, got %d (%s)", w.Code, w.Body.String())
	}
	if associator.calls != 1 {
		t.Fatalf("the live projection must resolve associations once per read, got %d", associator.calls)
	}
	var body Response
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("live body must be JSON: %v", err)
	}
	for _, node := range body.Nodes {
		switch node.ComponentID {
		case "smf":
			if node.InventoryResourceID != "11111111-2222-3333-4444-555555555555" {
				t.Fatalf("an associated node must carry its Inventory resource, got %q", node.InventoryResourceID)
			}
		case "upf":
			if node.InventoryResourceID != "" {
				t.Fatalf("an unassociated node must not invent a resource, got %q", node.InventoryResourceID)
			}
		}
	}
}

type snapshotProviderFunc func() *runtimeinv.Snapshot

func (f snapshotProviderFunc) Snapshot() *runtimeinv.Snapshot { return f() }

func withPrincipal(req *http.Request, role string) *http.Request {
	return req.WithContext(auth.ContextWithPrincipal(req.Context(), &auth.Principal{
		Username:       "test-" + role,
		Role:           role,
		NormalizedRole: role,
	}))
}
