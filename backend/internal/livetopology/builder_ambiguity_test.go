package livetopology

import (
	"testing"

	"subscriber/internal/runtimeinv"
)

func ambiguitySnapshot(ids ...string) *runtimeinv.Snapshot {
	snapshot := &runtimeinv.Snapshot{
		Host:        runtimeinv.HostIdentity{HostID: "host-test", HostName: "test-host"},
		GeneratedAt: "2026-11-01T00:00:00Z",
	}
	for _, id := range ids {
		snapshot.Components = append(snapshot.Components, runtimeinv.Observation{
			ComponentID:   id,
			DisplayName:   id,
			ProcessName:   id,
			Role:          "smf",
			Domain:        "5gc",
			RuntimeStatus: runtimeinv.StatusRunning,
		})
	}
	snapshot.Counts = runtimeinv.SnapshotCounts{Total: len(ids), Running: len(ids)}
	return snapshot
}

func testListener(protocol, address string, port int) Endpoint {
	return Endpoint{Protocol: protocol, Address: address, Port: port}
}

func testPfcpPeer(address string, port int) peer {
	return peer{Protocol: "pfcp", Address: address, Port: port}
}

func unresolvedReasonFor(response *Response, componentID, protocol, label string) string {
	for _, item := range response.Unresolved {
		if item.ComponentID == componentID && item.Protocol == protocol && item.Peer == label {
			return item.Reason
		}
	}
	return ""
}

func edgeBetween(response *Response, from, to string) bool {
	for _, edge := range response.Edges {
		if edge.FromComponentID == from && edge.ToComponentID == to {
			return true
		}
	}
	return false
}

/* A configured peer whose address and port belong to two different components is
 * ambiguous. It must never collapse into a certain edge against whichever
 * listener happened to be indexed last. */
func TestAmbiguousEndpointNeverCreatesCertainEdge(t *testing.T) {
	parsed := map[string]*parsedComponent{
		"smf": {
			ComponentID: "smf",
			Listeners:   []Endpoint{testListener("pfcp", "127.0.0.4", 8805)},
			Peers:       []peer{testPfcpPeer("127.0.0.7", 8805)},
		},
		"upf": {
			ComponentID: "upf",
			Listeners:   []Endpoint{testListener("pfcp", "127.0.0.7", 8805)},
		},
		"upfB": {
			ComponentID: "upfB",
			Listeners:   []Endpoint{testListener("pfcp", "127.0.0.7", 8805)},
		},
	}
	response := Build(ambiguitySnapshot("smf", "upf", "upfB"), parsed, ConfigStatus{})

	if edgeBetween(response, "smf", "upf") || edgeBetween(response, "smf", "upfB") {
		t.Fatalf("an ambiguous endpoint must not become a certain edge: %+v", response.Edges)
	}
	reason := unresolvedReasonFor(response, "smf", "pfcp", "127.0.0.7:8805")
	if reason != reasonPeerEndpointAmbiguous {
		t.Fatalf("expected the endpoint-ambiguity reason, got %q (unresolved=%+v)", reason, response.Unresolved)
	}
}

/* The address matches but the port does not. That is a different endpoint, so it
 * is reported as a port mismatch rather than a generic miss or a guessed edge. */
func TestPortMismatchNeverCreatesCertainEdge(t *testing.T) {
	parsed := map[string]*parsedComponent{
		"smf": {
			ComponentID: "smf",
			Listeners:   []Endpoint{testListener("pfcp", "127.0.0.4", 8805)},
			Peers:       []peer{testPfcpPeer("127.0.0.7", 9999)},
		},
		"upf": {
			ComponentID: "upf",
			Listeners:   []Endpoint{testListener("pfcp", "127.0.0.7", 8805)},
		},
	}
	response := Build(ambiguitySnapshot("smf", "upf"), parsed, ConfigStatus{})

	if edgeBetween(response, "smf", "upf") {
		t.Fatalf("a port mismatch must not become a certain edge: %+v", response.Edges)
	}
	reason := unresolvedReasonFor(response, "smf", "pfcp", "127.0.0.7:9999")
	if reason != reasonPeerPortMismatch {
		t.Fatalf("expected the port-mismatch reason, got %q (unresolved=%+v)", reason, response.Unresolved)
	}
}

/* Two components claiming the same Diameter identity make the FQDN ambiguous. */
func TestAmbiguousIdentityNeverCreatesCertainEdge(t *testing.T) {
	parsed := map[string]*parsedComponent{
		"icscf": {
			ComponentID: "icscf",
			Listeners:   []Endpoint{testListener("diameter", "127.0.0.9", 3869)},
			Peers:       []peer{{Protocol: "diameter", FQDN: "hss.ims.example", Port: 3868}},
		},
		"hssA": {
			ComponentID: "hssA",
			Listeners:   []Endpoint{testListener("diameter", "127.0.0.8", 3868)},
			Identities:  []string{"hss.ims.example"},
		},
		"hssB": {
			ComponentID: "hssB",
			Listeners:   []Endpoint{testListener("diameter", "127.0.0.10", 3868)},
			Identities:  []string{"hss.ims.example"},
		},
	}
	response := Build(ambiguitySnapshot("icscf", "hssA", "hssB"), parsed, ConfigStatus{})

	if edgeBetween(response, "icscf", "hssA") || edgeBetween(response, "icscf", "hssB") {
		t.Fatalf("an ambiguous identity must not become a certain edge: %+v", response.Edges)
	}
	reason := unresolvedReasonFor(response, "icscf", "diameter", "hss.ims.example")
	if reason != reasonPeerIdentityAmbiguous {
		t.Fatalf("expected the identity-ambiguity reason, got %q (unresolved=%+v)", reason, response.Unresolved)
	}
}

/* The strict rule must not break a peer that does resolve exactly once. */
func TestExactEndpointResolutionStillCreatesEdge(t *testing.T) {
	parsed := map[string]*parsedComponent{
		"smf": {
			ComponentID: "smf",
			Listeners:   []Endpoint{testListener("pfcp", "127.0.0.4", 8805)},
			Peers:       []peer{testPfcpPeer("127.0.0.7", 8805)},
		},
		"upf": {
			ComponentID: "upf",
			Listeners:   []Endpoint{testListener("pfcp", "127.0.0.7", 8805)},
		},
	}
	response := Build(ambiguitySnapshot("smf", "upf"), parsed, ConfigStatus{})

	if !edgeBetween(response, "smf", "upf") {
		t.Fatalf("an exact address and port match must still produce the edge: %+v", response.Edges)
	}
	if len(response.Unresolved) != 0 {
		t.Fatalf("a resolved peer must not be reported as unresolved: %+v", response.Unresolved)
	}
}

/* A peer that names one identity while its endpoint belongs to a component that
 * declares a different identity is a contradiction: neither side may be
 * silently preferred, so no certain edge is produced. */
func TestIdentityConflictWithEndpointOwnerNeverCreatesCertainEdge(t *testing.T) {
	parsed := map[string]*parsedComponent{
		"pcrf": {
			ComponentID: "pcrf",
			Listeners:   []Endpoint{testListener("diameter", "192.168.64.128", 3891)},
			Peers: []peer{{
				Protocol: "diameter",
				FQDN:     "uniransim-af.epc.example",
				Address:  "192.168.64.128",
				Port:     3893,
			}},
		},
		"pcf": {
			ComponentID: "pcf",
			Listeners:   []Endpoint{testListener("diameter", "192.168.64.128", 3893)},
			Identities:  []string{"pcf.epc.example"},
		},
	}
	response := Build(ambiguitySnapshot("pcrf", "pcf"), parsed, ConfigStatus{})

	if edgeBetween(response, "pcrf", "pcf") {
		t.Fatalf("a contradicting identity must not become a certain edge: %+v", response.Edges)
	}
	reason := unresolvedReasonFor(response, "pcrf", "diameter", "uniransim-af.epc.example")
	if reason != reasonPeerIdentityConflict {
		t.Fatalf("expected the identity-conflict reason, got %q (unresolved=%+v)", reason, response.Unresolved)
	}
}

/* The same shape without a declared identity on the target stays an address
 * match: components such as the open5gs SBI endpoints never declare a Diameter
 * identity, and their configured peers must keep resolving. */
func TestEndpointMatchStillResolvesWhenTheTargetDeclaresNoIdentity(t *testing.T) {
	parsed := map[string]*parsedComponent{
		"pcrf": {
			ComponentID: "pcrf",
			Listeners:   []Endpoint{testListener("diameter", "192.168.64.128", 3891)},
			Peers: []peer{{
				Protocol: "diameter",
				FQDN:     "uniransim-af.epc.example",
				Address:  "192.168.64.128",
				Port:     3893,
			}},
		},
		"pcf": {
			ComponentID: "pcf",
			Listeners:   []Endpoint{testListener("diameter", "192.168.64.128", 3893)},
		},
	}
	response := Build(ambiguitySnapshot("pcrf", "pcf"), parsed, ConfigStatus{})

	if !edgeBetween(response, "pcrf", "pcf") {
		t.Fatalf("an endpoint match without a declared identity must still resolve: %+v", response.Unresolved)
	}
}

/* A peer whose identity matches the endpoint owner resolves as before. */
func TestIdentityAgreeingWithTheEndpointOwnerStillResolves(t *testing.T) {
	parsed := map[string]*parsedComponent{
		"pcrf": {
			ComponentID: "pcrf",
			Listeners:   []Endpoint{testListener("diameter", "192.168.64.128", 3891)},
			Peers: []peer{{
				Protocol: "diameter",
				FQDN:     "pcf.epc.example",
				Address:  "192.168.64.128",
				Port:     3893,
			}},
		},
		"pcf": {
			ComponentID: "pcf",
			Listeners:   []Endpoint{testListener("diameter", "192.168.64.128", 3893)},
			Identities:  []string{"pcf.epc.example"},
		},
	}
	response := Build(ambiguitySnapshot("pcrf", "pcf"), parsed, ConfigStatus{})

	if !edgeBetween(response, "pcrf", "pcf") {
		t.Fatalf("an agreeing identity must still resolve: %+v", response.Unresolved)
	}
}
