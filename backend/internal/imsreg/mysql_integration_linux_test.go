//go:build linux

package imsreg

import (
	"context"
	"database/sql"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"
	"time"

	"github.com/go-sql-driver/mysql"
)

// The opt-in fixture owns its process, data directory and account namespace.
// It never reads a configured application database or a caller-provided DSN.
func ownedMySQL(t *testing.T) (*sql.DB, string) {
	t.Helper()
	if os.Getenv("IMS_TEST_MYSQLD") != "1" {
		t.Skip("set IMS_TEST_MYSQLD=1 for an owned MySQL fixture")
	}
	binary, e := exec.LookPath("mysqld")
	if e != nil {
		t.Fatal(e)
	}
	root := t.TempDir()
	data := filepath.Join(root, "data")
	logs := filepath.Join(root, "mysql.log")
	init := exec.Command(binary, "--no-defaults", "--initialize-insecure", "--datadir="+data, "--log-error="+logs)
	if b, e := init.CombinedOutput(); e != nil {
		t.Fatalf("owned mysql initialize: %v %s", e, b)
	}
	listener, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	address := listener.Addr().String()
	port := listener.Addr().(*net.TCPAddr).Port
	listener.Close()
	cmd := exec.Command(binary, "--no-defaults", "--datadir="+data, "--socket="+filepath.Join(root, "mysql.sock"), "--pid-file="+filepath.Join(root, "mysql.pid"), fmt.Sprintf("--port=%d", port), "--bind-address=127.0.0.1", "--mysqlx=0", "--skip-log-bin", "--default-time-zone=+08:00", "--log-error="+logs)
	if e = cmd.Start(); e != nil {
		t.Fatal(e)
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	t.Cleanup(func() {
		_ = cmd.Process.Signal(syscall.SIGTERM)
		select {
		case <-done:
		case <-time.After(10 * time.Second):
			_ = cmd.Process.Kill()
			<-done
		}
	})
	cfg := mysql.NewConfig()
	cfg.User = "root"
	cfg.Net = "tcp"
	cfg.Addr = address
	cfg.Timeout = time.Second
	connector, e := mysql.NewConnector(cfg)
	if e != nil {
		t.Fatal(e)
	}
	db := sql.OpenDB(connector)
	t.Cleanup(func() { db.Close() })
	deadline := time.Now().Add(20 * time.Second)
	for {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		e = db.PingContext(ctx)
		cancel()
		if e == nil {
			break
		}
		if time.Now().After(deadline) {
			b, _ := os.ReadFile(logs)
			t.Fatalf("owned mysql readiness: %v %s", e, b)
		}
		time.Sleep(100 * time.Millisecond)
	}
	statements := []string{
		"CREATE DATABASE ims_scscf", "CREATE DATABASE ims_hss",
		"CREATE TABLE ims_scscf.impu(id int PRIMARY KEY,impu varchar(64) NOT NULL,reg_state int)",
		"CREATE TABLE ims_scscf.contact(id int PRIMARY KEY,contact varchar(255) NOT NULL,expires datetime)",
		"CREATE TABLE ims_scscf.impu_contact(impu_id int NOT NULL,contact_id int NOT NULL)",
		"CREATE TABLE ims_hss.impu(id int PRIMARY KEY,identity varchar(255) NOT NULL)",
		"CREATE TABLE ims_hss.impi(id int PRIMARY KEY,identity varchar(255) NOT NULL,k tinyblob)",
		"CREATE TABLE ims_hss.impi_impu(id_impi int NOT NULL,id_impu int NOT NULL)",
		"INSERT INTO ims_scscf.impu VALUES (1,'sip:alice@ims.test',1),(2,'tel:+12025550123',1),(3,'sip:unbound@ims.test',0),(4,'sip:expired@ims.test',1),(5,'sip:unknown@ims.test',9)",
		"INSERT INTO ims_scscf.contact VALUES (1,'sip:alice@127.0.0.1;token=private',NOW()+INTERVAL 1 HOUR),(2,'sip:expired@127.0.0.1',NOW()-INTERVAL 1 HOUR),(3,'sip:unknown@127.0.0.1',NULL)",
		"INSERT INTO ims_scscf.impu_contact VALUES (1,1),(1,1),(2,1),(4,2),(5,3)",
		"INSERT INTO ims_hss.impu VALUES (1,'sip:alice@ims.test'),(2,'tel:+12025550123')",
		"INSERT INTO ims_hss.impi VALUES (1,'alice@ims.test','private-authentication-material'),(2,'other@ims.test','private-authentication-material')",
		"INSERT INTO ims_hss.impi_impu VALUES (1,1),(1,2),(2,1)",
		"CREATE USER 'observer'@'127.0.0.1' IDENTIFIED BY 'isolated-fixture-only'",
		"GRANT SELECT ON ims_scscf.* TO 'observer'@'127.0.0.1'",
		"GRANT SELECT (id,identity) ON ims_hss.impi TO 'observer'@'127.0.0.1'",
		"GRANT SELECT (id,identity) ON ims_hss.impu TO 'observer'@'127.0.0.1'",
		"GRANT SELECT (id_impi,id_impu) ON ims_hss.impi_impu TO 'observer'@'127.0.0.1'",
		"CREATE USER 'writer'@'127.0.0.1' IDENTIFIED BY 'isolated-fixture-only'",
		"GRANT SELECT,INSERT ON ims_scscf.* TO 'writer'@'127.0.0.1'",
	}
	for _, statement := range statements {
		if _, e = db.Exec(statement); e != nil {
			t.Fatalf("fixture schema: %v", e)
		}
	}
	return db, address
}
func fixtureSource(address string) Source {
	s := testSource("a", resourceA)
	s.SCSCF = Connection{Address: address, Database: "ims_scscf", User: "observer", PasswordEnv: "IMS_FIXTURE_PASSWORD"}
	hss := s.SCSCF
	hss.Database = "ims_hss"
	s.HSS = &hss
	return s
}
func TestMySQLNativeProjectionAndIdentityMapping(t *testing.T) {
	admin, address := ownedMySQL(t)
	source := fixtureSource(address)
	reader := NewMySQLReader(func(string) string { return "isolated-fixture-only" })
	defer reader.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	observation, e := reader.Read(ctx, source, 100)
	if e != nil {
		t.Fatal(e)
	}
	if observation.Complete || observation.Reason != "invalid_values" || len(observation.Items) != 5 {
		t.Fatalf("unknown states must leave exact totals unavailable: %+v", observation)
	}
	if len(observation.Items[0].Bindings) != 1 || observation.Items[0].Bindings[0].URI != "sip:alice@127.0.0.1" {
		t.Fatal("duplicate or private Contact projection")
	}
	if delta := time.Until(*observation.Items[0].Bindings[0].ExpiresAt); delta < 59*time.Minute || delta > 61*time.Minute {
		t.Fatalf("database timezone conversion: %s", delta)
	}
	if observation.Items[2].State != "no_active_binding_observed" || observation.Items[3].State != "no_active_binding_observed" || observation.Items[4].State != "unknown" {
		t.Fatal("expiry / missing-binding / unknown-state semantics")
	}
	state, e := reader.Enrich(ctx, source, observation.Items)
	if e != nil || state != "ok" {
		t.Fatalf("identity projection: %s %v", state, e)
	}
	if observation.Items[0].IdentityState != "ambiguous" || len(observation.Items[0].PrivateIdentities) != 2 || len(observation.Items[0].MSISDNs) != 1 {
		t.Fatal("explicit identity mapping or ambiguity was lost")
	}
	if _, e = admin.Exec("DELETE FROM ims_scscf.impu WHERE id=5"); e != nil {
		t.Fatal(e)
	}
	if _, e = admin.Exec("DELETE FROM ims_scscf.impu_contact WHERE impu_id=5"); e != nil {
		t.Fatal(e)
	}
	s := NewService(Catalog{Sources: []Source{source}}, nil, reader, testGroups(resourceA))
	if _, e = admin.Exec("INSERT INTO ims_scscf.impu_contact VALUES (3,1)"); e != nil {
		t.Fatal(e)
	}
	inactive, e := reader.Read(ctx, source, 100)
	if e != nil || inactive.Items[2].State != "no_active_binding_observed" || inactive.Items[2].Bindings[0].State != "inactive" {
		t.Fatal("an unregistered identity with a future Contact must not become active")
	}
	out, e := s.Read(ctx, testQuery())
	if e != nil || out.Counts.ActiveBindings == nil || *out.Counts.ActiveBindings != 1 || *out.Counts.ActivePublicIdentities != 2 {
		t.Fatalf("native denominators: %v %+v", e, out.Counts)
	}
	short, e := reader.Read(ctx, source, 2)
	if e != nil || short.Complete {
		t.Fatal("row truncation was hidden")
	}
	writer := source
	for id := 100; id < 118; id++ {
		if _, e = admin.Exec("INSERT INTO ims_hss.impu VALUES (?,?)", id, fmt.Sprintf("tel:+1555000%d", id)); e != nil {
			t.Fatal(e)
		}
		if _, e = admin.Exec("INSERT INTO ims_hss.impi_impu VALUES (1,?)", id); e != nil {
			t.Fatal(e)
		}
	}
	state, e = reader.Enrich(ctx, source, observation.Items)
	if e != nil || state != "partial" || len(observation.Items[0].MSISDNs) != 16 || observation.Items[0].IdentityState != "ambiguous_partial" || observation.Items[2].IdentityState != "partial" {
		t.Fatal("bounded HSS projections must expose truncation and never infer an absent mapping")
	}
	writer.SCSCF.User = "writer"
	if _, e = reader.Read(ctx, writer, 100); reason(e) != "readonly_account_required" {
		t.Fatalf("write-capable account was not rejected: %v", e)
	}
}
