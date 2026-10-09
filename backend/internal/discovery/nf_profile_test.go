package discovery

import (
	"strings"
	"testing"
)

func TestNormalizeNFProfileDiscoveryShape(t *testing.T) {
	raw := []byte(`{
		"nfInstanceId":"3301e63a-c3b7-41f1-a512-9f6322e6f4c2",
		"nfType":"AMF",
		"nfStatus":"REGISTERED",
		"heartBeatTimer":10,
		"plmnList":[{"mcc":"460","mnc":"02"}],
		"ipv4Addresses":["127.0.0.5"],
		"nfServices":[{
			"serviceInstanceId":"33021254-c3b7-41f1-a512-9f6322e6f4c2",
			"serviceName":"namf-comm",
			"versions":[{"apiVersionInUri":"v1","apiFullVersion":"1.0.0"}],
			"scheme":"http",
			"nfServiceStatus":"REGISTERED",
			"ipEndPoints":[{"ipv4Address":"127.0.0.5","port":7777}]
		}]
	}`)
	p, err := NormalizeNFProfile(raw)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if p.ExternalNfInstanceID != "3301e63a-c3b7-41f1-a512-9f6322e6f4c2" {
		t.Fatalf("nfInstanceId = %q", p.ExternalNfInstanceID)
	}
	if p.NfType != "AMF" || p.NfStatus != "REGISTERED" {
		t.Fatalf("nfType/nfStatus = %q/%q", p.NfType, p.NfStatus)
	}
	if len(p.ObservedServices) != 1 || p.ObservedServices[0].ServiceName != "namf-comm" {
		t.Fatalf("services = %+v", p.ObservedServices)
	}
	if len(p.ObservedEndpoints) != 1 || p.ObservedEndpoints[0].Address != "127.0.0.5" {
		t.Fatalf("endpoints = %+v", p.ObservedEndpoints)
	}
	if p.ObservedEndpoints[0].Port != 7777 {
		t.Fatalf("port = %d", p.ObservedEndpoints[0].Port)
	}
}

func TestNormalizeNFProfileManagementDictShape(t *testing.T) {
	raw := []byte(`{
		"nfInstanceId":"2fdd9616-c3b7-41f1-9e90-c1bf0278f435",
		"nfType":"UDM",
		"nfStatus":"REGISTERED",
		"ipv4Addresses":["127.0.0.12"],
		"nfServiceList":{
			"2fddcf28-c3b7-41f1-9e90-c1bf0278f435":{"serviceName":"nudm-ueau","nfServiceStatus":"REGISTERED","scheme":"http"},
			"2fddd004-c3b7-41f1-9e90-c1bf0278f435":{"serviceName":"nudm-uecm","nfServiceStatus":"REGISTERED","scheme":"http"}
		}
	}`)
	p, err := NormalizeNFProfile(raw)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(p.ObservedServices) != 2 {
		t.Fatalf("expected 2 services, got %d", len(p.ObservedServices))
	}
	names := map[string]bool{}
	for _, s := range p.ObservedServices {
		names[s.ServiceName] = true
	}
	if !names["nudm-ueau"] || !names["nudm-uecm"] {
		t.Fatalf("service names = %v", names)
	}
}

func TestNormalizeNFProfileDoesNotInventMissingFields(t *testing.T) {
	raw := []byte(`{"nfInstanceId":"2e9e441c-c3b7-41f1-89a3-b51475eb7e96","nfType":"SCP","nfStatus":"REGISTERED"}`)
	p, err := NormalizeNFProfile(raw)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if p.Fqdn != "" {
		t.Fatalf("fqdn should stay absent, got %q", p.Fqdn)
	}
	if len(p.ObservedServices) != 0 {
		t.Fatalf("services should stay absent, got %+v", p.ObservedServices)
	}
	if p.IPv4Addresses != nil {
		t.Fatalf("ipv4 should stay absent, got %v", p.IPv4Addresses)
	}
}

func TestParseHALCollection(t *testing.T) {
	raw := []byte(`{"_links":{"item":[
		{"href":"http://127.0.0.10:7777/nnrf-nfm/v1/nf-instances/aaa"},
		{"href":"http://127.0.0.10:7777/nnrf-nfm/v1/nf-instances/bbb"}
	],"self":{"href":"http://127.0.0.10:7777/nnrf-nfm/v1/nf-instances"}},"totalItemCount":9}`)
	col, hrefs, err := ParseHALCollection(raw)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if col.TotalItemCount == nil || *col.TotalItemCount != 9 {
		t.Fatalf("totalItemCount = %v", col.TotalItemCount)
	}
	if len(hrefs) != 2 {
		t.Fatalf("hrefs = %v", hrefs)
	}
}

func TestParseDiscoveryResponse(t *testing.T) {
	raw := []byte(`{"validityPeriod":30,"nfInstances":[
		{"nfInstanceId":"x","nfType":"SMF","nfStatus":"REGISTERED"},
		{"nfInstanceId":"","nfType":"SKIP","nfStatus":"REGISTERED"}
	]}`)
	profiles, err := ParseDiscoveryResponse(raw)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(profiles) != 1 {
		t.Fatalf("expected empty-id profile to be skipped, got %d", len(profiles))
	}
	if profiles[0].NfType != "SMF" {
		t.Fatalf("nfType = %q", profiles[0].NfType)
	}
}

func TestParseDiscoveryResponseEmptyIsNotError(t *testing.T) {
	raw := []byte(`{"validityPeriod":30,"nfInstances":[]}`)
	profiles, err := ParseDiscoveryResponse(raw)
	if err != nil {
		t.Fatalf("valid empty result must not error: %v", err)
	}
	if len(profiles) != 0 {
		t.Fatalf("expected empty result, got %d", len(profiles))
	}
}

func TestNormalizeRejectsMalformedJSON(t *testing.T) {
	if _, err := NormalizeNFProfile([]byte(`{not-json`)); err == nil {
		t.Fatal("expected error for malformed JSON")
	}
}

func TestServiceCapEnforced(t *testing.T) {
	var b strings.Builder
	b.WriteString(`{"nfInstanceId":"id","nfType":"SMF","nfStatus":"REGISTERED","nfServices":[`)
	for i := 0; i < MaxNFServicesPerInst+10; i++ {
		if i > 0 {
			b.WriteString(",")
		}
		b.WriteString(`{"serviceName":"svc","nfServiceStatus":"REGISTERED"}`)
	}
	b.WriteString(`]}`)
	p, err := NormalizeNFProfile([]byte(b.String()))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(p.ObservedServices) > MaxNFServicesPerInst {
		t.Fatalf("service cap not enforced: %d", len(p.ObservedServices))
	}
}
