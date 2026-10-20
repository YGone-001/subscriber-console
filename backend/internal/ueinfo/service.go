package ueinfo

import (
	"context"
	"sort"
	"strings"
	"time"

	"subscriber/internal/nfhealth"
)

const (
	DefaultLimit     = 50
	MaxLimit         = 200
	MaxOffset        = 100000
	MaxUpstreamItems = 2000
	maxSUPILength    = 64
)

// SubscriberLookup enriches UE records with xCloud subscriber MSISDNs and
// supplies the total subscriber count. It is read-only.
type SubscriberLookup interface {
	LookupMSISDNs(ctx context.Context, imsis []string) (map[string]string, error)
	Count(ctx context.Context) (int64, error)
}

// Service merges the approved UE sources into one bounded projection.
type Service struct {
	sources     Sources
	configErr   error
	fetcher     Fetcher
	subscribers SubscriberLookup
	now         func() time.Time
}

func NewService(sources Sources, configErr error, fetcher Fetcher, subscribers SubscriberLookup) *Service {
	if fetcher == nil {
		fetcher = NewHTTPFetcher()
	}
	return &Service{
		sources:     sources,
		configErr:   configErr,
		fetcher:     fetcher,
		subscribers: subscribers,
		now:         time.Now,
	}
}

// Snapshot fetches and merges every configured source. A failed source never
// becomes a zero count; its status is explicit and its contribution is absent.
func (s *Service) Snapshot(ctx context.Context) Snapshot {
	now := s.now().UTC()
	if s.configErr != nil {
		return Snapshot{
			GeneratedAt: now.Format(time.RFC3339Nano),
			Configured:  false,
			Complete:    false,
			Sources:     []SourceStatus{{ID: "config", State: SourceInvalidConfig}},
		}
	}
	if !s.sources.Configured() {
		return Snapshot{
			GeneratedAt: now.Format(time.RFC3339Nano),
			Configured:  false,
			Complete:    false,
			Sources:     []SourceStatus{{ID: "config", State: SourceNotConfigured}},
		}
	}

	ctx, cancel := context.WithTimeout(ctx, upstreamTimeout+time.Second)
	defer cancel()

	type roleItems struct {
		id    string
		items []upstreamUE
		err   error
	}
	type roleText struct {
		id   string
		body []byte
		err  error
	}

	itemCh := make(chan roleItems, 3)
	textCh := make(chan roleText, 1)
	itemCount := 0
	var epcOnlineUsers *int64
	if s.sources.MME != "" {
		itemCount++
		go func() {
			items, err := s.fetcher.FetchUEInfo(ctx, s.sources.MME)
			itemCh <- roleItems{id: "mme", items: items, err: err}
		}()
	}
	if s.sources.AMF != "" {
		itemCount++
		go func() {
			items, err := s.fetcher.FetchUEInfo(ctx, s.sources.AMF)
			itemCh <- roleItems{id: "amf", items: items, err: err}
		}()
	}
	if s.sources.SMF != "" {
		itemCount++
		go func() {
			items, err := s.fetcher.FetchPDUInfo(ctx, s.sources.SMF)
			itemCh <- roleItems{id: "smf", items: items, err: err}
		}()
		go func() {
			body, err := s.fetcher.FetchUESActive(ctx, s.sources.SMF)
			textCh <- roleText{id: "smf_metrics", body: body, err: err}
		}()
	}

	sourceByID := map[string]SourceStatus{
		"mme":         {ID: "mme", State: SourceNotConfigured},
		"amf":         {ID: "amf", State: SourceNotConfigured},
		"smf":         {ID: "smf", State: SourceNotConfigured},
		"smf_metrics": {ID: "smf_metrics", State: SourceNotConfigured},
		"subscribers": {ID: "subscribers", State: SourceNotConfigured},
		"ims":         {ID: "ims", State: SourceNotConfigured},
	}

	merged := map[string]*UE{}
	for index := 0; index < itemCount; index++ {
		result := <-itemCh
		status := sourceByID[result.id]
		if result.err != nil {
			status.State = SourceUnavailable
			status.Reason = sourceReason(result.err)
			sourceByID[result.id] = status
			continue
		}
		status.State = SourceOK
		status.ItemCount = len(result.items)
		sourceByID[result.id] = status
		for _, item := range result.items {
			mergeUpstream(merged, item)
		}
	}

	if s.sources.SMF != "" {
		result := <-textCh
		status := sourceByID["smf_metrics"]
		if result.err != nil {
			status.State = SourceUnavailable
			status.Reason = sourceReason(result.err)
			sourceByID["smf_metrics"] = status
		} else {
			value, reason := parseUESActive(result.body, now)
			if reason != "" {
				status.State = SourceUnavailable
				status.Reason = reason
			} else {
				status.State = SourceOK
				epcOnlineUsers = value
			}
			sourceByID["smf_metrics"] = status
		}
	}

	items := make([]UE, 0, len(merged))
	for _, item := range merged {
		items = append(items, *item)
	}
	sort.Slice(items, func(i, j int) bool { return items[i].SUPI < items[j].SUPI })

	var totalSubscribers *int64
	if s.subscribers != nil {
		status := sourceByID["subscribers"]
		if count, err := s.subscribers.Count(ctx); err != nil {
			status.State = SourceUnavailable
			status.Reason = ReasonNetworkError
		} else {
			status.State = SourceOK
			totalSubscribers = &count
		}
		sourceByID["subscribers"] = status
	}

	imsis := make([]string, 0, len(items))
	for _, item := range items {
		if item.SUPI != "" {
			imsis = append(imsis, item.SUPI)
		}
	}
	if s.subscribers != nil && len(imsis) > 0 {
		msisdns, err := s.subscribers.LookupMSISDNs(ctx, imsis)
		if err != nil {
			status := sourceByID["subscribers"]
			status.State = SourceUnavailable
			status.Reason = ReasonNetworkError
			sourceByID["subscribers"] = status
		} else {
			for index := range items {
				if items[index].MSISDN == "" {
					items[index].MSISDN = msisdns[items[index].SUPI]
				}
			}
		}
	}

	summary := summarize(items)
	summary.TotalSubscribers = totalSubscribers
	summary.EPC5GCOnlineUsers = epcOnlineUsers

	sources := []SourceStatus{
		sourceByID["mme"],
		sourceByID["amf"],
		sourceByID["smf"],
		sourceByID["smf_metrics"],
		sourceByID["subscribers"],
		sourceByID["ims"],
	}
	complete := sourceByID["mme"].State == SourceOK &&
		sourceByID["amf"].State == SourceOK &&
		sourceByID["smf"].State == SourceOK &&
		sourceByID["smf_metrics"].State == SourceOK
	for _, source := range sources {
		if source.State == SourceUnavailable {
			complete = false
		}
	}

	return Snapshot{
		GeneratedAt: now.Format(time.RFC3339Nano),
		Configured:  true,
		Complete:    complete,
		Summary:     summary,
		Sources:     sources,
		Items:       items,
	}
}

func mergeUpstream(merged map[string]*UE, item upstreamUE) {
	supi := normalizeSUPI(item.SUPI)
	if supi == "" {
		return
	}
	pdn := convertPDN(item.PDN)
	if existing, ok := merged[supi]; ok {
		fillUE(existing, item, pdn)
		return
	}
	converted := &UE{
		SUPI:     supi,
		MSISDN:   strings.TrimSpace(item.MSISDN),
		SIPURI:   strings.TrimSpace(item.SIPURI),
		Domain:   strings.TrimSpace(item.Domain),
		RAT:      strings.TrimSpace(item.RAT),
		CMState:  strings.TrimSpace(item.CMState),
		MMState:  strings.TrimSpace(item.MMState),
		ENB:      convertENB(item.ENB),
		Location: convertLocation(item.Location),
		AMBR:     convertAMBR(item.AMBR),
		PDN:      pdn,
		PDNCount: len(pdn),
	}
	merged[supi] = converted
}

func fillUE(target *UE, item upstreamUE, pdn []PDN) {
	if target.MSISDN == "" {
		target.MSISDN = strings.TrimSpace(item.MSISDN)
	}
	if target.SIPURI == "" {
		target.SIPURI = strings.TrimSpace(item.SIPURI)
	}
	if target.Domain == "" {
		target.Domain = strings.TrimSpace(item.Domain)
	}
	if target.RAT == "" {
		target.RAT = strings.TrimSpace(item.RAT)
	}
	if target.CMState == "" {
		target.CMState = strings.TrimSpace(item.CMState)
	}
	if target.MMState == "" {
		target.MMState = strings.TrimSpace(item.MMState)
	}
	if target.ENB == nil {
		target.ENB = convertENB(item.ENB)
	}
	if target.Location == nil {
		target.Location = convertLocation(item.Location)
	}
	if target.AMBR == nil {
		target.AMBR = convertAMBR(item.AMBR)
	}
	target.PDN = appendUniquePDN(target.PDN, pdn)
	target.PDNCount = len(target.PDN)
}

func appendUniquePDN(existing, incoming []PDN) []PDN {
	if len(incoming) == 0 {
		return existing
	}
	seen := make(map[string]bool, len(existing)+len(incoming))
	for _, item := range existing {
		seen[pdnKey(item)] = true
	}
	for _, item := range incoming {
		key := pdnKey(item)
		if seen[key] {
			continue
		}
		seen[key] = true
		existing = append(existing, item)
	}
	return existing
}

func pdnKey(item PDN) string {
	return strings.Join([]string{item.APN, intString(item.EBI), intString(item.QCI), item.IPv4, item.IPv6}, "|")
}

func intString(value int) string {
	if value == 0 {
		return "0"
	}
	negative := value < 0
	if negative {
		value = -value
	}
	var digits []byte
	for value > 0 {
		digits = append([]byte{byte('0' + value%10)}, digits...)
		value /= 10
	}
	if negative {
		return "-" + string(digits)
	}
	return string(digits)
}

func convertENB(item *upstreamENB) *ENB {
	if item == nil {
		return nil
	}
	return &ENB{ENBID: item.ENBID, CellID: item.CellID, Status: item.Status}
}

func convertLocation(item *upstreamLocation) *Location {
	if item == nil {
		return nil
	}
	return &Location{PLMN: item.TAI.PLMN, TAC: item.TAI.TAC, Timestamp: item.Timestamp}
}

func convertAMBR(item *upstreamAMBR) *AMBR {
	if item == nil {
		return nil
	}
	return &AMBR{Downlink: item.Downlink, Uplink: item.Uplink}
}

func convertPDN(items []upstreamPDN) []PDN {
	if len(items) == 0 {
		return nil
	}
	out := make([]PDN, 0, len(items))
	for _, item := range items {
		flows := make([]QoSFlow, 0, len(item.QoSFlows))
		for _, flow := range item.QoSFlows {
			flows = append(flows, QoSFlow{EBI: flow.EBI, QCI: flow.QCI})
		}
		out = append(out, PDN{
			APN: item.APN, QCI: item.QCI, EBI: item.EBI, PDUState: item.PDUState,
			QoSFlows: flows, IPv4: item.IPv4, IPv6: item.IPv6,
		})
	}
	return out
}

func normalizeSUPI(raw string) string {
	supi := strings.TrimSpace(raw)
	if len(supi) >= 5 && strings.EqualFold(supi[:5], "imsi-") {
		supi = supi[5:]
	}
	if len(supi) > maxSUPILength {
		supi = supi[:maxSUPILength]
	}
	return supi
}

func summarize(items []UE) Summary {
	summary := Summary{Total: len(items)}
	mmReported := false
	cmReported := false
	registered := 0
	idle := 0
	connected := 0
	for _, item := range items {
		if item.MMState != "" {
			mmReported = true
			if strings.EqualFold(item.MMState, "registered") {
				registered++
			}
		}
		if item.CMState != "" {
			cmReported = true
			switch {
			case strings.EqualFold(item.CMState, "idle"):
				idle++
			case strings.EqualFold(item.CMState, "connected"):
				connected++
			}
		}
		if item.MMState == "" && item.CMState == "" {
			summary.StateUnreported++
		}
	}
	if mmReported {
		summary.Registered = &registered
	}
	if cmReported {
		summary.Idle = &idle
		summary.Connected = &connected
	}
	return summary
}

// FilterAndPage applies validated query filters to the merged items.
func FilterAndPage(items []UE, query Query) ([]UE, int) {
	filtered := make([]UE, 0, len(items))
	search := strings.ToLower(strings.TrimSpace(query.Search))
	for _, item := range items {
		if search != "" {
			haystack := strings.ToLower(item.SUPI + " " + item.MSISDN + " " + item.SIPURI)
			if !strings.Contains(haystack, search) {
				continue
			}
		}
		if query.Domain != "" && !domainMatches(item.Domain, query.Domain) {
			continue
		}
		if query.State != "" && stateOf(item) != query.State {
			continue
		}
		filtered = append(filtered, item)
	}
	total := len(filtered)
	if query.Offset > total {
		query.Offset = total
	}
	filtered = filtered[query.Offset:]
	if len(filtered) > query.Limit {
		filtered = filtered[:query.Limit]
	}
	return filtered, total
}

func domainMatches(itemDomain, filter string) bool {
	left := canonicalDomain(itemDomain)
	right := canonicalDomain(filter)
	return left != "" && left == right
}

func canonicalDomain(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "eps", "epc", "lte", "e-utra":
		return "EPS"
	case "5gs", "5g", "5gc", "nr":
		return "5GS"
	default:
		return ""
	}
}

func stateOf(item UE) string {
	if strings.EqualFold(item.MMState, "registered") {
		return "registered"
	}
	if strings.EqualFold(item.CMState, "idle") {
		return "idle"
	}
	if strings.EqualFold(item.CMState, "connected") {
		return "connected"
	}
	return "unknown"
}

func parseUESActive(body []byte, now time.Time) (*int64, string) {
	outcome, err := nfhealth.ParsePrometheusText(body, now.UTC().Format(time.RFC3339Nano), nil, "5gc", "SMF")
	if err != nil {
		return nil, ReasonInvalidResponse
	}
	for _, sample := range outcome.Samples {
		if sample.Key != "ues_active" {
			continue
		}
		value := int64(sample.Value)
		if value < 0 {
			return nil, ReasonInvalidResponse
		}
		return &value, ""
	}
	return nil, ReasonMetricAbsent
}
