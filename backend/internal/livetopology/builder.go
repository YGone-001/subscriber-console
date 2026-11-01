package livetopology

import (
	"fmt"
	"sort"
	"strings"
	"time"

	"subscriber/internal/runtimeinv"
)

type listenerRef struct {
	ComponentID string
	Endpoint    Endpoint
}

// Reasons a configured peer stays unresolved. They are part of the read
// projection: an operator must be able to tell "nothing matched" from "several
// things matched" and from "the address matched but the port did not".
const (
	reasonPeerUnresolved        = "peer does not resolve to a configured component endpoint"
	reasonPeerIdentityAmbiguous = "peer identity matches more than one configured component"
	reasonPeerEndpointAmbiguous = "peer endpoint matches more than one configured component"
	reasonPeerPortMismatch      = "peer port does not match any configured endpoint"
)

// appendListenerRef keeps one entry per component and endpoint. Two different
// components advertising the same endpoint stay two entries: that is exactly the
// ambiguity the resolver must refuse to guess through.
func appendListenerRef(refs []listenerRef, ref listenerRef) []listenerRef {
	for _, existing := range refs {
		if existing.ComponentID == ref.ComponentID &&
			existing.Endpoint.Protocol == ref.Endpoint.Protocol &&
			existing.Endpoint.Port == ref.Endpoint.Port &&
			normalizeAddress(existing.Endpoint.Address) == normalizeAddress(ref.Endpoint.Address) {
			return refs
		}
	}
	return append(refs, ref)
}

type edgeBuilder struct {
	edge Edge
}

func normalizeAddress(value string) string {
	return strings.ToLower(strings.TrimSuffix(strings.TrimSpace(value), "."))
}

func roleToken(value string) string {
	var builder strings.Builder
	for _, char := range strings.ToLower(strings.TrimSpace(value)) {
		if (char >= 'a' && char <= 'z') || (char >= '0' && char <= '9') {
			builder.WriteRune(char)
		}
	}
	return builder.String()
}

func interfaceNamesFor(protocol, fromRole, toRole string) []string {
	left, right := roleToken(fromRole), roleToken(toRole)
	pair := left + "|" + right
	reverse := right + "|" + left
	switch protocol {
	case "pfcp":
		if pair == "smf|upf" || reverse == "smf|upf" {
			return []string{"N4"}
		}
		if pair == "sgwc|sgwu" || reverse == "sgwc|sgwu" {
			return []string{"Sxa"}
		}
	case "gtpc":
		if pair == "mme|sgwc" || reverse == "mme|sgwc" {
			return []string{"S11"}
		}
	case "diameter":
		switch {
		case pair == "mme|hss" || reverse == "mme|hss":
			return []string{"S6a"}
		case pair == "pcscf|pcrf" || reverse == "pcscf|pcrf":
			return []string{"Rx"}
		case pair == "icscf|hss" || reverse == "icscf|hss",
			pair == "scscf|hss" || reverse == "scscf|hss":
			return []string{"Cx"}
		case pair == "scscf|ocs" || reverse == "scscf|ocs":
			return []string{"Ro"}
		case pair == "pcrf|pgwc" || reverse == "pcrf|pgwc":
			return []string{"Gx"}
		case pair == "pgwc|ocs" || reverse == "pgwc|ocs":
			return []string{"Gy"}
		case pair == "pcrf|ocs" || reverse == "pcrf|ocs":
			return []string{"Sy"}
		}
	case "sip":
		switch {
		case pair == "pcscf|icscf" || reverse == "pcscf|icscf",
			pair == "icscf|scscf" || reverse == "icscf|scscf",
			pair == "pcscf|scscf" || reverse == "pcscf|scscf":
			return []string{"Mw"}
		}
	}
	return []string{}
}

func statusObserved(status string) bool {
	switch status {
	case runtimeinv.StatusRunning, runtimeinv.StatusStopped, runtimeinv.StatusNotDetected:
		return true
	default:
		return false
	}
}

func statusState(from, to string) string {
	if from == runtimeinv.StatusRunning && to == runtimeinv.StatusRunning {
		return EdgeActive
	}
	if from == runtimeinv.StatusRunning || to == runtimeinv.StatusRunning {
		if statusObserved(from) && statusObserved(to) {
			return EdgePartial
		}
		return EdgeUnknown
	}
	// Inactive requires a successful observation of both endpoints as stopped.
	// A permission failure, an unverified identity, a stale observation or a
	// component that was never detected must never be reported as inactive.
	if from == runtimeinv.StatusStopped && to == runtimeinv.StatusStopped {
		return EdgeInactive
	}
	return EdgeUnknown
}

func sortEndpoints(items []Endpoint) []Endpoint {
	sort.SliceStable(items, func(i, j int) bool {
		if items[i].Protocol != items[j].Protocol {
			return items[i].Protocol < items[j].Protocol
		}
		if items[i].Address != items[j].Address {
			return items[i].Address < items[j].Address
		}
		return items[i].Port < items[j].Port
	})
	return items
}

func dedupeEndpoints(items []Endpoint) []Endpoint {
	seen := map[string]struct{}{}
	result := make([]Endpoint, 0, len(items))
	for _, endpoint := range items {
		key := fmt.Sprintf("%s|%s|%d", endpoint.Protocol, normalizeAddress(endpoint.Address), endpoint.Port)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		result = append(result, endpoint)
	}
	return sortEndpoints(result)
}

func dedupeStrings(items []string) []string {
	seen := map[string]struct{}{}
	result := make([]string, 0, len(items))
	for _, item := range items {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		if _, ok := seen[item]; ok {
			continue
		}
		seen[item] = struct{}{}
		result = append(result, item)
	}
	sort.Strings(result)
	return result
}

// Build combines runtime nodes with configured peers. A peer is only connected
// when its configured address/port or FQDN resolves to another component; no
// role-pair guessing is performed.
func Build(snapshot *runtimeinv.Snapshot, parsed map[string]*parsedComponent, configStatus ConfigStatus) *Response {
	response := &Response{
		Config: configStatus,
		Nodes:  []Node{},
		Edges:  []Edge{},
	}
	if snapshot == nil {
		response.GeneratedAt = time.Now().UTC().Format(time.RFC3339)
		return response
	}
	response.GeneratedAt = snapshot.GeneratedAt
	if response.GeneratedAt == "" {
		response.GeneratedAt = time.Now().UTC().Format(time.RFC3339)
	}
	response.Host = Host{HostID: snapshot.Host.HostID, HostName: snapshot.Host.HostName}
	response.Runtime = runtimeSummary(snapshot)

	componentByID := map[string]runtimeinv.Observation{}
	identities := map[string]map[string]struct{}{}
	byAddressPort := map[string][]listenerRef{}
	byAddress := map[string][]listenerRef{}
	for _, component := range snapshot.Components {
		componentByID[component.ComponentID] = component
		node := Node{
			ComponentID:   component.ComponentID,
			DisplayName:   component.DisplayName,
			ProcessName:   component.ProcessName,
			Role:          component.Role,
			NFType:        component.NFTType,
			Domain:        component.Domain,
			RuntimeStatus: component.RuntimeStatus,
			StatusReason:  component.StatusReason,
		}
		if component.InventoryAssociation.State == runtimeinv.AssociationAssociated {
			node.InventoryResourceID = component.InventoryAssociation.ID
		}
		if componentParsed, ok := parsed[component.ComponentID]; ok {
			node.Listeners = dedupeEndpoints(componentParsed.Listeners)
			for _, identity := range componentParsed.Identities {
				key := normalizeAddress(identity)
				if key == "" {
					continue
				}
				owners, ok := identities[key]
				if !ok {
					owners = map[string]struct{}{}
					identities[key] = owners
				}
				owners[component.ComponentID] = struct{}{}
			}
		}
		response.Nodes = append(response.Nodes, node)
	}
	for componentID, componentParsed := range parsed {
		if componentParsed == nil {
			continue
		}
		for _, listener := range componentParsed.Listeners {
			if listener.Port <= 0 || strings.TrimSpace(listener.Address) == "" {
				continue
			}
			ref := listenerRef{ComponentID: componentID, Endpoint: listener}
			address := normalizeAddress(listener.Address)
			portKey := fmt.Sprintf("%s|%s|%d", listener.Protocol, address, listener.Port)
			byAddressPort[portKey] = appendListenerRef(byAddressPort[portKey], ref)
			addressKey := fmt.Sprintf("%s|%s", listener.Protocol, address)
			byAddress[addressKey] = appendListenerRef(byAddress[addressKey], ref)
		}
	}

	edgeIndex := map[string]*edgeBuilder{}
	unresolvedIndex := map[string]struct{}{}
	var unresolved []UnresolvedPeer
	addUnresolved := func(componentID string, item peer, reason string) {
		label := item.FQDN
		if label == "" {
			label = item.Address
			if item.Port > 0 {
				label = fmt.Sprintf("%s:%d", label, item.Port)
			}
		}
		if label == "" {
			label = "unconfigured"
		}
		key := componentID + "|" + item.Protocol + "|" + label
		if _, exists := unresolvedIndex[key]; exists || len(unresolved) >= 64 {
			return
		}
		unresolvedIndex[key] = struct{}{}
		unresolved = append(unresolved, UnresolvedPeer{
			ComponentID: componentID, Protocol: item.Protocol, Peer: label, Reason: reason,
		})
	}

	parsedIDs := make([]string, 0, len(parsed))
	for componentID := range parsed {
		parsedIDs = append(parsedIDs, componentID)
	}
	sort.Strings(parsedIDs)
	for _, componentID := range parsedIDs {
		componentParsed := parsed[componentID]
		if componentParsed == nil {
			continue
		}
		fromComponent, exists := componentByID[componentID]
		if !exists {
			continue
		}
		for _, item := range componentParsed.Peers {
			protocol := item.Protocol
			port := item.Port
			if port == 0 {
				port = defaultPort(protocol)
			}
			targetID := ""
			var targetEndpoint Endpoint
			unresolvedReason := ""
			if item.FQDN != "" {
				switch owners := identities[normalizeAddress(item.FQDN)]; len(owners) {
				case 1:
					for id := range owners {
						targetID = id
						if idParsed, ok := parsed[id]; ok {
							for _, listener := range idParsed.Listeners {
								if listener.Protocol == protocol {
									targetEndpoint = listener
									break
								}
							}
						}
					}
				case 0:
					// A peer may name both an identity and an address; the address
					// form is tried below before the peer is declared unmatched.
				default:
					unresolvedReason = reasonPeerIdentityAmbiguous
				}
			}
			if targetID == "" && unresolvedReason == "" && item.Address != "" {
				address := normalizeAddress(item.Address)
				portKey := fmt.Sprintf("%s|%s|%d", protocol, address, port)
				switch refs := byAddressPort[portKey]; len(refs) {
				case 1:
					targetID = refs[0].ComponentID
					targetEndpoint = refs[0].Endpoint
				case 0:
					/* Strict identity: a listener on a different port is a different
					 * endpoint, so it never becomes a certain edge. Report which of
					 * the two misses actually happened. */
					switch sameAddress := byAddress[fmt.Sprintf("%s|%s", protocol, address)]; len(sameAddress) {
					case 1:
						unresolvedReason = reasonPeerPortMismatch
					case 0:
						// Nothing matched at all; the generic reason below applies.
					default:
						unresolvedReason = reasonPeerEndpointAmbiguous
					}
				default:
					unresolvedReason = reasonPeerEndpointAmbiguous
				}
			}
			if targetID == "" {
				if unresolvedReason == "" {
					unresolvedReason = reasonPeerUnresolved
				}
				addUnresolved(componentID, item, unresolvedReason)
				continue
			}
			if targetID == componentID {
				continue
			}
			targetComponent, exists := componentByID[targetID]
			if !exists {
				addUnresolved(componentID, item, "resolved component is absent from the runtime registry")
				continue
			}
			fromEndpoint := Endpoint{Protocol: protocol, SourceFile: item.SourceFile}
			if fromParsed, ok := parsed[componentID]; ok {
				for _, listener := range fromParsed.Listeners {
					if listener.Protocol == protocol {
						fromEndpoint = listener
						break
					}
				}
			}
			if targetEndpoint.Protocol == "" {
				targetEndpoint = Endpoint{Protocol: protocol, SourceFile: item.SourceFile}
			}
			interfaces := interfaceNamesFor(protocol, fromComponent.Role, targetComponent.Role)
			pair := []string{componentID, targetID}
			sort.Strings(pair)
			edgeKey := fmt.Sprintf("%s|%s|%s", protocol, pair[0], pair[1])
			builder, exists := edgeIndex[edgeKey]
			if !exists {
				builder = &edgeBuilder{edge: Edge{
					EdgeID:           fmt.Sprintf("configured:%s:%s:%s", pair[0], pair[1], protocol),
					FromComponentID:  componentID,
					ToComponentID:    targetID,
					RelationshipType: "connects_to",
					Protocol:         protocol,
					Evidence:         EvidenceConfigured,
					State:            statusState(fromComponent.RuntimeStatus, targetComponent.RuntimeStatus),
					FromEndpoint:     fromEndpoint,
					ToEndpoint:       targetEndpoint,
				}}
				edgeIndex[edgeKey] = builder
			}
			builder.edge.InterfaceNames = dedupeStrings(append(builder.edge.InterfaceNames, interfaces...))
			builder.edge.SourceFiles = dedupeStrings(append(builder.edge.SourceFiles, item.SourceFile, fromEndpoint.SourceFile, targetEndpoint.SourceFile))
		}
	}

	edges := make([]Edge, 0, len(edgeIndex))
	for _, builder := range edgeIndex {
		if builder.edge.InterfaceNames == nil {
			builder.edge.InterfaceNames = []string{}
		}
		if builder.edge.SourceFiles == nil {
			builder.edge.SourceFiles = []string{}
		}
		edges = append(edges, builder.edge)
	}
	sort.SliceStable(edges, func(i, j int) bool {
		if edges[i].FromComponentID != edges[j].FromComponentID {
			return edges[i].FromComponentID < edges[j].FromComponentID
		}
		if edges[i].ToComponentID != edges[j].ToComponentID {
			return edges[i].ToComponentID < edges[j].ToComponentID
		}
		return edges[i].Protocol < edges[j].Protocol
	})
	sort.SliceStable(unresolved, func(i, j int) bool {
		if unresolved[i].ComponentID != unresolved[j].ComponentID {
			return unresolved[i].ComponentID < unresolved[j].ComponentID
		}
		return unresolved[i].Peer < unresolved[j].Peer
	})
	response.Edges = edges
	response.Unresolved = unresolved
	response.Summary = Summary{
		NodeCount:           len(response.Nodes),
		EdgeCount:           len(response.Edges),
		ConfiguredEdgeCount: len(response.Edges),
		UnresolvedPeerCount: len(response.Unresolved),
	}
	return response
}
