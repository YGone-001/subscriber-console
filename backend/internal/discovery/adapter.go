package discovery

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"strings"
)

// ObservationBatch is the vendor-neutral result of one bounded discovery read.
// A nil error with Complete=false means the read was truncated or partial and
// must not be used to infer absence.
type ObservationBatch struct {
	Profiles  []*NormalizedProfile
	Complete  bool
	Truncated bool
	SourceURL string
	// APIFamily identifies the 3GPP service family that produced this batch.
	// This adapter only issues Nnrf_NFManagement reads, so the value is "nnrf-nfm".
	APIFamily string
}

// Adapter is the vendor-neutral, read-only discovery contract. Future EPC and IMS
// adapters implement this interface without changing the candidate repository.
type Adapter interface {
	// Type returns the canonical adapter type identifier.
	Type() string
	// Discover performs a bounded read-only observation of the configured source.
	Discover(ctx context.Context, src DiscoverySource) (*ObservationBatch, error)
}

// ErrUnsupportedAdapter is returned when no adapter is registered for a source.
var ErrUnsupportedAdapter = errors.New("unsupported discovery adapter type")

// ErrSourceDisabled is returned when a scan is requested for a disabled source.
var ErrSourceDisabled = errors.New("discovery source disabled")

// NRFAdapter reads NF candidates from a 3GPP NRF using only bounded, read-only
// Nnrf_NFManagement collection operations: GET of the nf-instances collection
// and GET of each linked NF profile. It never issues PUT, PATCH, DELETE, or
// subscription-create requests, and it does not query Nnrf_NFDiscovery.
//
// API support boundary for this build:
//
//	implemented : Nnrf_NFManagement GET collection + GET NF profile
//	not issued  : Nnrf_NFDiscovery search, subscriptions, any write verb
type NRFAdapter struct {
	client    *NRFClient
	allowlist *DestinationAllowlist
}

// NewNRFAdapter constructs the 3GPP NRF read-only adapter.
func NewNRFAdapter(client *NRFClient, allowlist *DestinationAllowlist) *NRFAdapter {
	return &NRFAdapter{client: client, allowlist: allowlist}
}

// Type implements Adapter.
func (a *NRFAdapter) Type() string { return AdapterNRF }

// Discover implements Adapter.
func (a *NRFAdapter) Discover(ctx context.Context, src DiscoverySource) (*ObservationBatch, error) {
	if !src.Enabled {
		return nil, ErrSourceDisabled
	}
	base, err := ValidateTarget(src.BaseURL, a.allowlist)
	if err != nil {
		return nil, err
	}

	baseURL := strings.TrimRight(base.String(), "/")
	collectionURL := baseURL + "/nnrf-nfm/v1/nf-instances"

	body, _, status, err := a.client.GetJSON(ctx, collectionURL, src.TransportMode, a.allowlist)
	if err != nil {
		return nil, err
	}
	if status < 200 || status > 299 {
		return nil, fmt.Errorf("%w: nf management returned status %d", ErrProtocol, status)
	}

	col, hrefs, err := ParseHALCollection(body)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrProtocol, err)
	}

	batch := &ObservationBatch{
		SourceURL: collectionURL,
		APIFamily: "nnrf-nfm",
		Complete:  true,
	}

	limit := MaxNFProfiles
	if col.TotalItemCount != nil && *col.TotalItemCount > MaxNFProfiles {
		batch.Truncated = true
		batch.Complete = false
	}

	for i, href := range hrefs {
		if i >= limit {
			batch.Truncated = true
			batch.Complete = false
			break
		}
		linkURL, linkErr := ValidateLink(href, base, a.allowlist)
		if linkErr != nil {
			// A rejected link is evidence of an incomplete scan, not of absence.
			batch.Complete = false
			batch.Truncated = true
			continue
		}
		raw, _, itemStatus, getErr := a.client.GetJSON(ctx, linkURL.String(), src.TransportMode, a.allowlist)
		if getErr != nil {
			return nil, getErr
		}
		if itemStatus < 200 || itemStatus > 299 {
			return nil, fmt.Errorf("%w: nf profile returned status %d", ErrProtocol, itemStatus)
		}
		profile, normErr := NormalizeNFProfile(raw)
		if normErr != nil {
			return nil, fmt.Errorf("%w: %v", ErrProtocol, normErr)
		}
		if profile.ExternalNfInstanceID == "" {
			continue
		}
		batch.Profiles = append(batch.Profiles, profile)
	}

	// Reserved extension point only. It performs no network I/O in this build.
	a.enrichFromDiscovery(ctx, src, batch)

	return batch, nil
}

// enrichFromDiscovery is a reserved extension point for a future supplementary
// search pass. It intentionally performs no network I/O and issues no request of
// any kind.
//
// This build does not implement Nnrf_NFDiscovery querying. Observation batches
// are built exclusively from the verified read-only Nnrf_NFManagement collection
// and per-profile GET operations in Discover. No speculative 3GPP query
// parameters and no generic collection read are sent from here.
func (a *NRFAdapter) enrichFromDiscovery(_ context.Context, _ DiscoverySource, _ *ObservationBatch) {
}

// AdapterRegistry maps adapter type identifiers to implementations.
type AdapterRegistry struct {
	adapters map[string]Adapter
}

// NewAdapterRegistry builds the registry of vendor adapters.
func NewAdapterRegistry(adapters ...Adapter) *AdapterRegistry {
	reg := &AdapterRegistry{adapters: map[string]Adapter{}}
	for _, a := range adapters {
		reg.adapters[a.Type()] = a
	}
	return reg
}

// Get returns the adapter for a type identifier.
func (r *AdapterRegistry) Get(adapterType string) (Adapter, error) {
	a, ok := r.adapters[adapterType]
	if !ok {
		return nil, ErrUnsupportedAdapter
	}
	return a, nil
}

// MustAllowlistURL is a helper used by validation to check a candidate base URL
// against the destination allowlist without performing any I/O.
func MustAllowlistURL(raw string, allowlist *DestinationAllowlist) error {
	_, err := ValidateTarget(raw, allowlist)
	return err
}

// SchemeAllowed reports whether the URL scheme is supported for discovery.
func SchemeAllowed(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil {
		return false
	}
	return u.Scheme == "http" || u.Scheme == "https"
}
