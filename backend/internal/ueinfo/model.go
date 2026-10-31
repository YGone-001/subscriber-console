package ueinfo

// Source states are stable presentation tokens.
const (
	SourceOK            = "ok"
	SourceUnavailable   = "unavailable"
	SourceNotConfigured = "not_configured"
	SourceInvalidConfig = "invalid_config"
)

// Source reasons are safe, bounded tokens; raw upstream errors are never exposed.
const (
	ReasonTimeout         = "timeout"
	ReasonNetworkError    = "network_error"
	ReasonHTTPError       = "http_error"
	ReasonInvalidResponse = "invalid_response"
	ReasonMetricAbsent    = "metric_absent"
	ReasonTruncated       = "truncated"
)

// UE is one merged EPC/5GC user-equipment record.
type UE struct {
	SUPI     string    `json:"supi"`
	MSISDN   string    `json:"msisdn,omitempty"`
	SIPURI   string    `json:"sipUri,omitempty"`
	Domain   string    `json:"domain"`
	RAT      string    `json:"rat"`
	CMState  string    `json:"cmState"`
	MMState  string    `json:"mmState"`
	ENB      *ENB      `json:"enb,omitempty"`
	Location *Location `json:"location,omitempty"`
	AMBR     *AMBR     `json:"ambr,omitempty"`
	PDN      []PDN     `json:"pdn,omitempty"`
	PDNCount int       `json:"pdnCount"`
}

// ENB identifies the serving base station when the source reports it.
type ENB struct {
	ENBID  int    `json:"enbId"`
	CellID int    `json:"cellId"`
	Status string `json:"status"`
}

// Location is the tracked TAI and its observation timestamp.
type Location struct {
	PLMN      string `json:"plmn"`
	TAC       int    `json:"tac"`
	Timestamp int64  `json:"timestamp"`
}

// AMBR is the session aggregate maximum bit rate in bits per second.
type AMBR struct {
	Downlink int64 `json:"downlink"`
	Uplink   int64 `json:"uplink"`
}

// PDN is one packet-data session.
type PDN struct {
	APN      string    `json:"apn"`
	QCI      int       `json:"qci"`
	EBI      int       `json:"ebi"`
	PDUState string    `json:"pduState"`
	QoSFlows []QoSFlow `json:"qosFlows,omitempty"`
	IPv4     string    `json:"ipv4,omitempty"`
	IPv6     string    `json:"ipv6,omitempty"`
}

// QoSFlow is one bearer/QoS-flow descriptor.
type QoSFlow struct {
	EBI int `json:"ebi"`
	QCI int `json:"qci"`
}

// Summary is the platform-wide projection. Nil counts are unavailable, never zero.
type Summary struct {
	Total             int    `json:"total"`
	Registered        *int   `json:"registered"`
	Idle              *int   `json:"idle"`
	Connected         *int   `json:"connected"`
	StateUnreported   int    `json:"stateUnreported"`
	EPC5GCOnlineUsers *int64 `json:"epc5gcOnlineUsers"`
	IMSOnlineUsers    *int64 `json:"imsOnlineUsers"`
	TotalSubscribers  *int64 `json:"totalSubscribers"`
	TotalIMSUsers     *int64 `json:"totalIMSUsers"`
}

// SourceStatus describes one upstream source without exposing raw errors or URLs.
type SourceStatus struct {
	ID        string `json:"id"`
	State     string `json:"state"`
	Reason    string `json:"reason,omitempty"`
	ItemCount int    `json:"itemCount"`
}

// Pagination describes the filtered result window. `offset` remains for
// compatibility; `nextCursor`/`hasMore` are the canonical page controls.
type Pagination struct {
	Limit      int     `json:"limit"`
	Offset     int     `json:"offset"`
	Total      int     `json:"total"`
	NextCursor *string `json:"nextCursor"`
	HasMore    bool    `json:"hasMore"`
}

// Response is the GET /api/ue-info payload.
type Response struct {
	GeneratedAt string         `json:"generatedAt"`
	Configured  bool           `json:"configured"`
	Complete    bool           `json:"complete"`
	Summary     Summary        `json:"summary"`
	Sources     []SourceStatus `json:"sources"`
	Items       []UE           `json:"items"`
	Pagination  Pagination     `json:"pagination"`
}

// Query is the validated list request.
type Query struct {
	SummaryOnly bool
	Search      string
	Domain      string
	State       string
	Limit       int
	Offset      int
}

// Snapshot is the merged, unfiltered projection used by both views.
type Snapshot struct {
	GeneratedAt string
	Configured  bool
	Complete    bool
	Summary     Summary
	Sources     []SourceStatus
	Items       []UE
}

// upstreamUE mirrors the snake_case CNMS /ue-info and /pdu-info item shape.
type upstreamUE struct {
	SUPI     string            `json:"supi"`
	MSISDN   string            `json:"msisdn"`
	SIPURI   string            `json:"sip_uri"`
	Domain   string            `json:"domain"`
	RAT      string            `json:"rat"`
	CMState  string            `json:"cm_state"`
	MMState  string            `json:"mm_state"`
	ENB      *upstreamENB      `json:"enb"`
	Location *upstreamLocation `json:"location"`
	AMBR     *upstreamAMBR     `json:"ambr"`
	PDN      []upstreamPDN     `json:"pdn"`
	PDNCount int               `json:"pdn_count"`
}

type upstreamENB struct {
	ENBID  int    `json:"enb_id"`
	CellID int    `json:"cell_id"`
	Status string `json:"status"`
}

type upstreamLocation struct {
	TAI struct {
		PLMN string `json:"plmn"`
		TAC  int    `json:"tac"`
	} `json:"tai"`
	Timestamp int64 `json:"timestamp"`
}

type upstreamAMBR struct {
	Downlink int64 `json:"downlink"`
	Uplink   int64 `json:"uplink"`
}

type upstreamPDN struct {
	APN      string        `json:"apn"`
	QCI      int           `json:"qci"`
	EBI      int           `json:"ebi"`
	PDUState string        `json:"pdu_state"`
	QoSFlows []upstreamQoS `json:"qos_flows"`
	IPv4     string        `json:"ipv4"`
	IPv6     string        `json:"ipv6"`
}

type upstreamQoS struct {
	EBI int `json:"ebi"`
	QCI int `json:"qci"`
}

type upstreamResponse struct {
	Items []upstreamUE `json:"items"`
}
