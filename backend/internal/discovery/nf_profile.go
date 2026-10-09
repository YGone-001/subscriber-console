package discovery

import (
	"encoding/json"
	"strings"
)

// rawNFProfile is a tolerant decoder for 3GPP NFProfile documents observed from
// either Nnrf_NFManagement or Nnrf_NFDiscovery. Field spellings differ between
// the two APIs and across vendor stacks, so both shapes are accepted.
type rawNFProfile struct {
	NfInstanceID   string   `json:"nfInstanceId"`
	NfType         string   `json:"nfType"`
	NfStatus       string   `json:"nfStatus"`
	Fqdn           string   `json:"fqdn"`
	IPv4Addresses  []string `json:"ipv4Addresses"`
	IPv6Addresses  []string `json:"ipv6Addresses"`
	HeartBeatTimer int      `json:"heartBeatTimer"`
	Priority       int      `json:"priority"`
	Capacity       int      `json:"capacity"`
	Load           int      `json:"load"`
	PlmnList       []PlmnID `json:"plmnList"`
	SNssaiList     []SNssai `json:"sNssaiList"`
	// Nnrf_NFManagement returns nfServiceList as an object keyed by service id.
	NfServiceList json.RawMessage `json:"nfServiceList"`
	// Nnrf_NFDiscovery returns nfServices as an array.
	NfServices json.RawMessage `json:"nfServices"`
}

type rawNFService struct {
	ServiceInstanceID string   `json:"serviceInstanceId"`
	ServiceName       string   `json:"serviceName"`
	NfServiceStatus   string   `json:"nfServiceStatus"`
	Scheme            string   `json:"scheme"`
	Fqdn              string   `json:"fqdn"`
	IPv4Addresses     []string `json:"ipv4Addresses"`
	IPv6Addresses     []string `json:"ipv6Addresses"`
	APIVersions       []struct {
		APIVersionInURI string `json:"apiVersionInUri"`
		APIFullVersion  string `json:"apiFullVersion"`
	} `json:"versions"`
	IPEndPoints []struct {
		IPv4Address string `json:"ipv4Address"`
		IPv6Address string `json:"ipv6Address"`
		Port        int    `json:"port"`
	} `json:"ipEndPoints"`
}

// NormalizedProfile is the vendor-neutral projection of one NFProfile.
type NormalizedProfile struct {
	ExternalNfInstanceID string
	NfType               string
	NfStatus             string
	Fqdn                 string
	IPv4Addresses        []string
	IPv6Addresses        []string
	HeartBeatTimer       int
	PlmnList             []PlmnID
	SNssaiList           []SNssai
	ObservedServices     []ObservedService
	ObservedEndpoints    []ObservedEndpoint
}

// NormalizeNFProfile converts a raw NFProfile JSON document into the vendor-neutral
// observation shape. Missing fields stay absent; nothing is invented.
func NormalizeNFProfile(raw []byte) (*NormalizedProfile, error) {
	var p rawNFProfile
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, err
	}

	profile := &NormalizedProfile{
		ExternalNfInstanceID: strings.TrimSpace(p.NfInstanceID),
		NfType:               strings.TrimSpace(p.NfType),
		NfStatus:             strings.TrimSpace(p.NfStatus),
		Fqdn:                 strings.TrimSpace(p.Fqdn),
		IPv4Addresses:        compactStrings(p.IPv4Addresses),
		IPv6Addresses:        compactStrings(p.IPv6Addresses),
		HeartBeatTimer:       p.HeartBeatTimer,
		PlmnList:             p.PlmnList,
		SNssaiList:           p.SNssaiList,
	}

	services, err := decodeServices(p.NfServiceList, p.NfServices)
	if err != nil {
		return nil, err
	}

	for _, svc := range services {
		if len(profile.ObservedServices) >= MaxNFServicesPerInst {
			break
		}
		observed := ObservedService{
			ServiceName: strings.TrimSpace(svc.ServiceName),
			Status:      strings.TrimSpace(svc.NfServiceStatus),
		}
		for _, v := range svc.APIVersions {
			if v.APIVersionInURI != "" {
				observed.APIVersions = append(observed.APIVersions, v.APIVersionInURI)
			} else if v.APIFullVersion != "" {
				observed.APIVersions = append(observed.APIVersions, v.APIFullVersion)
			}
		}
		for _, ep := range svc.IPEndPoints {
			endpoint := ObservedEndpoint{
				ServiceName: observed.ServiceName,
				Scheme:      strings.TrimSpace(svc.Scheme),
			}
			switch {
			case ep.IPv4Address != "":
				endpoint.AddressType = "ipv4"
				endpoint.Address = ep.IPv4Address
			case ep.IPv6Address != "":
				endpoint.AddressType = "ipv6"
				endpoint.Address = ep.IPv6Address
			case svc.Fqdn != "":
				endpoint.AddressType = "fqdn"
				endpoint.Address = svc.Fqdn
			default:
				continue
			}
			endpoint.Port = ep.Port
			observed.Endpoints = append(observed.Endpoints, endpoint)
			profile.ObservedEndpoints = append(profile.ObservedEndpoints, endpoint)
		}
		if len(observed.Endpoints) == 0 && svc.Fqdn != "" {
			endpoint := ObservedEndpoint{
				ServiceName: observed.ServiceName,
				Scheme:      strings.TrimSpace(svc.Scheme),
				AddressType: "fqdn",
				Address:     svc.Fqdn,
			}
			observed.Endpoints = append(observed.Endpoints, endpoint)
			profile.ObservedEndpoints = append(profile.ObservedEndpoints, endpoint)
		}
		profile.ObservedServices = append(profile.ObservedServices, observed)
	}

	return profile, nil
}

// decodeServices accepts either the NFManagement object form or the Discovery
// array form of the NF service collection.
func decodeServices(listRaw, arrayRaw json.RawMessage) ([]rawNFService, error) {
	if len(arrayRaw) > 0 && string(arrayRaw) != "null" {
		var arr []rawNFService
		if err := json.Unmarshal(arrayRaw, &arr); err != nil {
			return nil, err
		}
		return arr, nil
	}
	if len(listRaw) > 0 && string(listRaw) != "null" {
		// Object keyed by service instance id.
		var obj map[string]rawNFService
		if err := json.Unmarshal(listRaw, &obj); err == nil {
			out := make([]rawNFService, 0, len(obj))
			for _, svc := range obj {
				out = append(out, svc)
			}
			return out, nil
		}
		// Some stacks still return an array under nfServiceList.
		var arr []rawNFService
		if err := json.Unmarshal(listRaw, &arr); err != nil {
			return nil, err
		}
		return arr, nil
	}
	return nil, nil
}

// ParseDiscoveryResponse parses an Nnrf_NFDiscovery search result.
// Observed live registry shape: {"validityPeriod":30,"nfInstances":[...]}.
func ParseDiscoveryResponse(raw []byte) ([]*NormalizedProfile, error) {
	var envelope struct {
		NfInstances []json.RawMessage `json:"nfInstances"`
		// Tolerate alternate spellings without inventing data.
		NfProfileList []json.RawMessage `json:"nfProfileList"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return nil, err
	}
	items := envelope.NfInstances
	if len(items) == 0 {
		items = envelope.NfProfileList
	}
	out := make([]*NormalizedProfile, 0, len(items))
	for _, item := range items {
		profile, err := NormalizeNFProfile(item)
		if err != nil {
			return nil, err
		}
		if profile.ExternalNfInstanceID == "" {
			continue
		}
		out = append(out, profile)
	}
	return out, nil
}

// HALCollection is the Nnrf_NFManagement collection envelope observed live:
// {"_links":{"item":[{"href":"..."}],"self":{"href":"..."}},"totalItemCount":N}.
type HALCollection struct {
	Links struct {
		Item []struct {
			Href string `json:"href"`
		} `json:"item"`
		Self struct {
			Href string `json:"href"`
		} `json:"self"`
	} `json:"_links"`
	TotalItemCount *int `json:"totalItemCount"`
}

// ParseHALCollection extracts bounded same-origin item links from an NFManagement
// collection document. No link is followed until the allowlist validates it.
func ParseHALCollection(raw []byte) (*HALCollection, []string, error) {
	var col HALCollection
	if err := json.Unmarshal(raw, &col); err != nil {
		return nil, nil, err
	}
	hrefs := make([]string, 0, len(col.Links.Item))
	for _, item := range col.Links.Item {
		href := strings.TrimSpace(item.Href)
		if href != "" {
			hrefs = append(hrefs, href)
		}
	}
	return &col, hrefs, nil
}

func compactStrings(in []string) []string {
	if len(in) == 0 {
		return nil
	}
	out := make([]string, 0, len(in))
	for _, s := range in {
		s = strings.TrimSpace(s)
		if s != "" {
			out = append(out, s)
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}
