package profile

import (
	"testing"

	"go.mongodb.org/mongo-driver/v2/bson"
)

func TestProfileListFilterHidesArchivedByDefault(t *testing.T) {
	excluded := profileListFilter(false)
	condition, ok := excluded["archived"].(bson.M)
	if !ok || condition["$ne"] != true {
		t.Fatalf("default filter must exclude archived documents, got %+v", excluded)
	}
	if len(profileListFilter(true)) != 0 {
		t.Fatal("includeArchived must not filter the collection")
	}
}

func TestProfileArchivedReadsOnlyTrue(t *testing.T) {
	if !profileArchived(bson.M{"archived": true}) {
		t.Fatal("archived=true must be reported")
	}
	if profileArchived(bson.M{}) || profileArchived(bson.M{"archived": false}) {
		t.Fatal("missing or false must not be reported as archived")
	}
}
