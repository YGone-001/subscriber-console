package nfhealth

import (
	"context"
	"testing"
)

func TestProfileTransitionRetainsAuthorizedProcessAndDestination(t *testing.T) {
	resource := "11111111-1111-4111-8111-111111111111"
	existing := &HealthTarget{ResourceID: resource, CollectorProfile: CollectorProcessOnly, ServiceKind: "process", ServiceUnit: "mmed", Domain: "epc", NFType: NFTypeMME}
	dest := NewDestinationAllowlist("127.0.0.2:9090")
	units := NewServiceUnitAllowlist("mmed,amfd")
	bindings := NewProcessBindingRegistry(resource + "=mmed")
	valid := MutableTarget{CollectorProfile: CollectorHTTPMetrics, Name: "MME", MetricsEndpoint: "http://127.0.0.2:9090/metrics", ServiceUnit: "mmed", ServiceKind: "process", CollectionMode: "manual", IntervalSeconds: 120, Enabled: true}
	for _, name := range []string{"valid", "omitted_profile", "drop_source", "repoint_source", "unapproved_endpoint", "empty_endpoint", "invalid_profile"} {
		t.Run(name, func(t *testing.T) {
			req := &UpdateTargetRequest{ExpectedRevision: 1, Target: valid}
			switch name {
			case "omitted_profile":
				req.Target.CollectorProfile = ""
			case "drop_source":
				req.Target.ServiceKind = "none"
				req.Target.ServiceUnit = ""
			case "repoint_source":
				req.Target.ServiceUnit = "amfd"
			case "unapproved_endpoint":
				req.Target.MetricsEndpoint = "http://127.0.0.99:9090/metrics"
			case "empty_endpoint":
				req.Target.MetricsEndpoint = ""
			case "invalid_profile":
				req.Target.CollectorProfile = "shell"
			}
			err := ValidateEffectiveTargetUpdate(existing, req, dest, units, bindings)
			if name == "valid" && err != nil {
				t.Fatal(err)
			}
			if name != "valid" && err == nil {
				t.Fatalf("invalid transition %s accepted", name)
			}
			if name == "omitted_profile" && EffectiveCollectorProfile(existing, req) != CollectorProcessOnly {
				t.Fatal("omitted profile changed")
			}
		})
	}
}

func TestProfileTransitionPersistenceAndCAS(t *testing.T) {
	repo, _, cleanup := nfhealthTestRepo(t)
	defer cleanup()
	target := createResourceNativeTarget(t, repo, "11111111-1111-4111-8111-111111111111", "transition fixture")
	req := &UpdateTargetRequest{ExpectedRevision: target.Revision, Target: MutableTarget{
		CollectorProfile: CollectorHTTPMetrics, Name: target.Name, ServiceKind: target.ServiceKind,
		ServiceUnit: target.ServiceUnit, MetricsEndpoint: "http://127.0.0.1:9090/metrics",
		CollectionMode: CollectionManual, IntervalSeconds: 120, Enabled: true,
	}}
	updated, _, err := repo.UpdateTarget(context.Background(), target.TargetID, req, "integration-tester")
	if err != nil {
		t.Fatal(err)
	}
	if updated.CollectorProfile != CollectorHTTPMetrics || updated.ResourceID != target.ResourceID || updated.ServiceUnit != target.ServiceUnit {
		t.Fatalf("identity/profile not preserved: %+v", updated)
	}
	if _, _, err := repo.UpdateTarget(context.Background(), target.TargetID, req, "integration-tester"); err != ErrRevisionConflict {
		t.Fatalf("stale revision accepted: %v", err)
	}
	req.ExpectedRevision = updated.Revision
	req.Target.CollectorProfile = ""
	updated, _, err = repo.UpdateTarget(context.Background(), target.TargetID, req, "integration-tester")
	if err != nil || updated.CollectorProfile != CollectorHTTPMetrics {
		t.Fatalf("legacy update lost profile: %v", err)
	}
}
