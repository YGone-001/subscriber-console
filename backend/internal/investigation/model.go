package investigation

import (
	"errors"
	"time"
)

const (
	MaxEdges     = 20
	MaxEvidence  = 128
	MaxEvents    = 384
	MaxKnowledge = 8
	MaxHistory   = 20
)

var ErrNotFound = errors.New("investigation record not found")
var ErrConflict = errors.New("investigation revision or request conflict")

type Failure struct {
	Status        int
	Code, Message string
}

func (f *Failure) Error() string                  { return f.Message }
func fail(status int, code, message string) error { return &Failure{status, code, message} }

// Evidence facts are positive projections; no raw bodies or configuration content.
type AlertFact struct {
	ID           string `json:"alertId" bson:"_id"`
	ResourceID   string `json:"resourceId" bson:"resourceId"`
	TargetID     string `json:"targetId" bson:"targetId"`
	Name         string `json:"name" bson:"ruleName"`
	Severity     string `json:"severity" bson:"severity"`
	State        string `json:"state" bson:"state"`
	First        string `json:"firstTriggeredAt" bson:"firstTriggeredAt"`
	Last         string `json:"lastTriggeredAt" bson:"lastTriggeredAt"`
	Acknowledged string `json:"acknowledgedAt,omitempty" bson:"acknowledgedAt"`
	Assigned     string `json:"assignedAt,omitempty" bson:"assignedAt"`
	Recovering   string `json:"recoveringAt,omitempty" bson:"recoveringAt"`
	Resolved     string `json:"resolvedAt,omitempty" bson:"resolvedAt"`
	TriggerCount int    `json:"triggerCount" bson:"triggerCount"`
}
type ResourceFact struct {
	ID        string `json:"resourceId" bson:"_id"`
	Name      string `json:"name" bson:"name"`
	Domain    string `json:"domain" bson:"domain"`
	Role      string `json:"role" bson:"role"`
	Kind      string `json:"kind" bson:"kind"`
	Lifecycle string `json:"lifecycleState" bson:"lifecycleState"`
}
type EdgeFact struct {
	ID       string `json:"edgeId" bson:"_id"`
	From     string `json:"fromResourceId" bson:"fromResourceId"`
	To       string `json:"toResourceId" bson:"toResourceId"`
	Type     string `json:"relationshipType" bson:"relationshipType"`
	Revision int64  `json:"revision" bson:"revision"`
}
type RunFact struct {
	ID         string `bson:"_id"`
	ResourceID string `bson:"resourceId"`
	TargetID   string `bson:"targetId"`
	SampleID   string `bson:"sampleId"`
	At         string `bson:"startedAt"`
	Outcome    string `bson:"status"`
}
type LayerState struct {
	State string `json:"state" bson:"state"`
}
type Layers struct {
	Process   LayerState `json:"process" bson:"process"`
	Interface LayerState `json:"interface" bson:"interface"`
	Service   LayerState `json:"service" bson:"service"`
}
type SampleFact struct {
	ID         string `bson:"_id"`
	RunID      string `bson:"runId"`
	ResourceID string `bson:"resourceId"`
	TargetID   string `bson:"targetId"`
	At         string `bson:"collectedAt"`
	Layers     Layers `bson:"layers"`
}
type ConfigFact struct {
	ID         string    `bson:"_id"`
	SourceID   string    `bson:"sourceId"`
	ResourceID string    `bson:"resourceId"`
	SnapshotID string    `bson:"snapshotId"`
	At         time.Time `bson:"collectedAt"`
	Outcome    string    `bson:"status"`
	Changed    *bool     `bson:"changed"`
}
type KnowledgeFact struct {
	ID       string `json:"id" bson:"_id"`
	Title    string `json:"title" bson:"title"`
	Protocol string `json:"protocol" bson:"protocol"`
	Revision int64  `json:"revision" bson:"revision"`
}
type Coverage struct {
	State           string `json:"state"`
	Reason          string `json:"reason,omitempty"`
	Returned        int    `json:"returned"`
	Limit           int    `json:"limit"`
	HistoryCoverage string `json:"historyCoverage"`
}
type Event struct {
	Key        string     `json:"key"`
	Kind       string     `json:"kind"`
	ID         string     `json:"id"`
	ResourceID string     `json:"resourceId"`
	TargetID   string     `json:"targetId,omitempty"`
	SourceID   string     `json:"sourceId,omitempty"`
	SnapshotID string     `json:"snapshotId,omitempty"`
	At         time.Time  `json:"at"`
	Name       string     `json:"name,omitempty"`
	Outcome    string     `json:"outcome"`
	Basis      string     `json:"basis"`
	Changed    *bool      `json:"changed"`
	Layers     *Layers    `json:"layers,omitempty"`
	MeasuredAt *time.Time `json:"measuredAt,omitempty"`
}
type ContextQuery struct{ AlertID, From, To, InvestigationID string }
type ContextView struct {
	GeneratedAt       time.Time           `json:"generatedAt"`
	From              time.Time           `json:"from"`
	To                time.Time           `json:"to"`
	Anchor            AlertFact           `json:"anchor"`
	Resources         []ResourceFact      `json:"resources"`
	Relations         []EdgeFact          `json:"relations"`
	Events            []Event             `json:"events"`
	Coverage          map[string]Coverage `json:"coverage"`
	Completeness      string              `json:"completeness"`
	RelationshipBasis string              `json:"relationshipBasis"`
}
type Change struct {
	Revision int64     `json:"revision" bson:"revision"`
	At       time.Time `json:"at" bson:"at"`
	Actor    string    `json:"actor" bson:"actor"`
	Status   string    `json:"status" bson:"status"`
}
type Record struct {
	ID            string    `json:"investigationId" bson:"_id"`
	AlertID       string    `json:"alertId" bson:"alertId"`
	ResourceID    string    `json:"resourceId" bson:"resourceId"`
	From          time.Time `json:"from" bson:"from"`
	To            time.Time `json:"to" bson:"to"`
	Title         string    `json:"title" bson:"title"`
	Status        string    `json:"status" bson:"status"`
	Notes         string    `json:"notes" bson:"notes"`
	Conclusion    string    `json:"conclusion" bson:"conclusion"`
	KnowledgeIDs  []string  `json:"knowledgeIds" bson:"knowledgeIds"`
	Revision      int64     `json:"revision" bson:"revision"`
	CreatedAt     time.Time `json:"createdAt" bson:"createdAt"`
	UpdatedAt     time.Time `json:"updatedAt" bson:"updatedAt"`
	CreatedBy     string    `json:"createdBy" bson:"createdBy"`
	UpdatedBy     string    `json:"updatedBy" bson:"updatedBy"`
	RecentChanges []Change  `json:"recentChanges" bson:"recentChanges"`
	RequestDigest string    `json:"-" bson:"requestDigest"`
}
type RecordView struct {
	Record            *Record         `json:"record"`
	Knowledge         []KnowledgeFact `json:"knowledge"`
	KnowledgeCoverage Coverage        `json:"knowledgeCoverage"`
}
type CreateRequest struct {
	RequestID string `json:"requestId"`
	AlertID   string `json:"alertId"`
	Title     string `json:"title"`
	From      string `json:"from"`
	To        string `json:"to"`
}
type UpdateRequest struct {
	ExpectedRevision int64    `json:"expectedRevision"`
	Title            string   `json:"title"`
	Status           string   `json:"status"`
	Notes            string   `json:"notes"`
	Conclusion       string   `json:"conclusion"`
	KnowledgeIDs     []string `json:"knowledgeIds"`
}
type ListQuery struct {
	Q, Status, AlertID, ResourceID, Cursor string
	Limit                                  int
}
type RecordSummary struct {
	ID         string    `json:"investigationId"`
	AlertID    string    `json:"alertId"`
	ResourceID string    `json:"resourceId"`
	Title      string    `json:"title"`
	Status     string    `json:"status"`
	Revision   int64     `json:"revision"`
	UpdatedAt  time.Time `json:"updatedAt"`
	UpdatedBy  string    `json:"updatedBy"`
}
type ListView struct {
	Items      []RecordSummary `json:"items"`
	NextCursor *string         `json:"nextCursor"`
	HasMore    bool            `json:"hasMore"`
}
