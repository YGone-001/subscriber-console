package imsreg

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/go-sql-driver/mysql"
)

// MySQLReader exposes only the fixed, positive projections below. Connection
// credentials never enter source metadata, errors, logs or cursor fingerprints.
type MySQLReader struct {
	mu     sync.Mutex
	pools  map[Connection]*sql.DB
	env    func(string) string
	closed bool
}

func NewMySQLReader(env func(string) string) *MySQLReader {
	if env == nil {
		env = os.Getenv
	}
	return &MySQLReader{pools: map[Connection]*sql.DB{}, env: env}
}
func (r *MySQLReader) Close() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.closed = true
	for _, p := range r.pools {
		_ = p.Close()
	}
	return nil
}
func (r *MySQLReader) pool(c Connection) (*sql.DB, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return nil, &ReadError{"unavailable"}
	}
	if p := r.pools[c]; p != nil {
		return p, nil
	}
	password := r.env(c.PasswordEnv)
	if password == "" {
		return nil, &ReadError{"credential_not_configured"}
	}
	cfg := mysql.NewConfig()
	cfg.User, cfg.Passwd, cfg.Net, cfg.Addr, cfg.DBName = c.User, password, "tcp", c.Address, c.Database
	cfg.ParseTime, cfg.Loc = true, time.UTC
	cfg.Timeout, cfg.ReadTimeout, cfg.WriteTimeout = 2*time.Second, 2*time.Second, 2*time.Second
	cfg.MultiStatements, cfg.AllowAllFiles, cfg.AllowCleartextPasswords = false, false, false
	if c.CAFile != "" {
		b, e := os.ReadFile(c.CAFile)
		if e != nil {
			return nil, &ReadError{"tls_configuration"}
		}
		roots := x509.NewCertPool()
		if !roots.AppendCertsFromPEM(b) {
			return nil, &ReadError{"tls_configuration"}
		}
		cfg.TLS = &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: roots, ServerName: c.ServerName}
	}
	connector, e := mysql.NewConnector(cfg)
	if e != nil {
		return nil, &ReadError{"invalid_config"}
	}
	p := sql.OpenDB(connector)
	p.SetMaxOpenConns(2)
	p.SetMaxIdleConns(1)
	p.SetConnMaxLifetime(2 * time.Minute)
	p.SetConnMaxIdleTime(30 * time.Second)
	r.pools[c] = p
	return p, nil
}

func safeReadError(err error) error {
	if e, ok := err.(*ReadError); ok {
		return e
	}
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		return &ReadError{"timeout"}
	}
	return &ReadError{"database_unavailable"}
}

// Only direct SELECT/SHOW VIEW grants are accepted. Role grants and broader
// privileges fail closed rather than guessing their effective capability.
func requireReadOnly(ctx context.Context, db *sql.DB) error {
	rows, e := db.QueryContext(ctx, "SHOW GRANTS FOR CURRENT_USER")
	if e != nil {
		return safeReadError(e)
	}
	defer rows.Close()
	selectGranted := false
	for rows.Next() {
		var grant string
		if rows.Scan(&grant) != nil {
			return &ReadError{"readonly_account_required"}
		}
		upper := strings.ToUpper(grant)
		before, _, ok := strings.Cut(upper, " ON ")
		if strings.Contains(upper, "WITH GRANT OPTION") {
			return &ReadError{"readonly_account_required"}
		}
		if !ok || !strings.HasPrefix(before, "GRANT ") {
			return &ReadError{"readonly_account_required"}
		}
		privileges, valid := splitPrivileges(strings.TrimPrefix(before, "GRANT "))
		if !valid {
			return &ReadError{"readonly_account_required"}
		}
		for _, privilege := range privileges {
			base := strings.TrimSpace(strings.SplitN(privilege, "(", 2)[0])
			switch base {
			case "USAGE", "SHOW VIEW":
			case "SELECT":
				selectGranted = true
			default:
				return &ReadError{"readonly_account_required"}
			}
		}
	}
	if rows.Err() != nil {
		return safeReadError(rows.Err())
	}
	if !selectGranted {
		return &ReadError{"readonly_account_required"}
	}
	return nil
}

func splitPrivileges(s string) ([]string, bool) {
	depth, start := 0, 0
	out := []string{}
	for i, c := range s {
		switch c {
		case '(':
			depth++
		case ')':
			depth--
			if depth < 0 {
				return nil, false
			}
		case ',':
			if depth == 0 {
				out = append(out, strings.TrimSpace(s[start:i]))
				start = i + 1
			}
		}
	}
	if depth != 0 {
		return nil, false
	}
	out = append(out, strings.TrimSpace(s[start:]))
	return out, true
}

type sqlQueryer interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

func validateSchema(ctx context.Context, tx sqlQueryer, hss bool) error {
	required := map[string]string{"impu.id": "int", "impu.impu": "varchar", "impu.reg_state": "int", "contact.id": "int", "contact.contact": "varchar", "contact.expires": "datetime", "impu_contact.impu_id": "int", "impu_contact.contact_id": "int"}
	if hss {
		required = map[string]string{"impu.id": "int", "impu.identity": "varchar", "impi.id": "int", "impi.identity": "varchar", "impi_impu.id_impi": "int", "impi_impu.id_impu": "int"}
	}
	rows, e := tx.QueryContext(ctx, "SELECT table_name,column_name,data_type FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name IN ('impu','contact','impu_contact','impi','impi_impu') LIMIT 128")
	if e != nil {
		return safeReadError(e)
	}
	defer rows.Close()
	for rows.Next() {
		var table, column, kind string
		if rows.Scan(&table, &column, &kind) != nil {
			return &ReadError{"unsupported_schema"}
		}
		key := table + "." + column
		if expected, ok := required[key]; ok {
			if expected != kind {
				return &ReadError{"unsupported_schema"}
			}
			delete(required, key)
		}
	}
	if rows.Err() != nil {
		return safeReadError(rows.Err())
	}
	if len(required) != 0 {
		return &ReadError{"unsupported_schema"}
	}
	return nil
}

func (r *MySQLReader) Read(ctx context.Context, s Source, budget int) (Observation, error) {
	result := Observation{Items: []Identity{}, Complete: true}
	if s.Persistence != "write_back" {
		return result, &ReadError{"persistence_not_current"}
	}
	if budget < 1 || budget > MaxRows {
		return result, &ReadError{"row_limit"}
	}
	db, e := r.pool(s.SCSCF)
	if e != nil {
		return result, e
	}
	if e = requireReadOnly(ctx, db); e != nil {
		return result, e
	}
	tx, e := db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true, Isolation: sql.LevelRepeatableRead})
	if e != nil {
		return result, safeReadError(e)
	}
	defer tx.Rollback()
	if e = validateSchema(ctx, tx, false); e != nil {
		return result, e
	}
	if e = tx.QueryRowContext(ctx, "SELECT UTC_TIMESTAMP(6)").Scan(&result.ReadAt); e != nil {
		return result, safeReadError(e)
	}
	rows, e := tx.QueryContext(ctx, "SELECT id,impu,reg_state FROM impu ORDER BY id LIMIT ?", budget+1)
	if e != nil {
		return result, safeReadError(e)
	}
	byID := map[int64]int{}
	states := map[int64]sql.NullInt64{}
	for rows.Next() {
		var id int64
		var identity string
		var state sql.NullInt64
		if e = rows.Scan(&id, &identity, &state); e != nil {
			rows.Close()
			return result, safeReadError(e)
		}
		if len(result.Items) >= budget {
			result.Complete = false
			break
		}
		if !safeIdentity(identity) {
			result.Complete = false
			result.Reason = "invalid_values"
			continue
		}
		byID[id] = len(result.Items)
		states[id] = state
		result.Items = append(result.Items, Identity{Key: fmt.Sprintf("%s:%020d", s.ID, id), SourceID: s.ID, ResourceID: s.ResourceID, PublicIdentity: identity, State: "unknown", Bindings: []Binding{}, PrivateIdentities: []string{}, MSISDNs: []string{}, IdentityState: "not_configured", ReadAt: result.ReadAt})
	}
	err := rows.Err()
	rows.Close()
	if err != nil {
		return result, safeReadError(err)
	}
	rows, e = tx.QueryContext(ctx, "SELECT ic.impu_id,c.id,c.contact,UNIX_TIMESTAMP(c.expires),CASE WHEN c.expires > NOW() THEN 1 WHEN c.expires IS NOT NULL AND c.expires > '1970-01-01' THEN 0 ELSE NULL END FROM impu_contact ic JOIN contact c ON c.id=ic.contact_id ORDER BY ic.impu_id,c.id LIMIT ?", budget+1)
	if e != nil {
		return result, safeReadError(e)
	}
	seen := map[string]bool{}
	n := 0
	for rows.Next() {
		var impuID, id int64
		var uri string
		var unix sql.NullFloat64
		var active sql.NullInt64
		if e = rows.Scan(&impuID, &id, &uri, &unix, &active); e != nil {
			rows.Close()
			return result, safeReadError(e)
		}
		n++
		if n > budget {
			result.Complete = false
			break
		}
		at, ok := byID[impuID]
		if !ok {
			result.Complete = false
			continue
		}
		key := strconv.FormatInt(id, 10)
		unique := result.Items[at].Key + ":" + key
		if seen[unique] {
			continue
		}
		seen[unique] = true
		binding := Binding{Key: key, URI: safeContact(uri), State: "unknown"}
		if unix.Valid && unix.Float64 > 0 {
			v := time.Unix(int64(unix.Float64), 0).UTC()
			binding.ExpiresAt = &v
		}
		if active.Valid && states[impuID].Valid {
			if states[impuID].Int64 == 0 || states[impuID].Int64 == -1 {
				binding.State = "inactive"
			} else if active.Int64 == 1 && states[impuID].Int64 == 1 {
				binding.State = "active"
			} else if active.Int64 == 0 {
				binding.State = "expired"
			}
		}
		result.Items[at].Bindings = append(result.Items[at].Bindings, binding)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return result, safeReadError(err)
	}
	readComplete := result.Complete
	for id, at := range byID {
		item := &result.Items[at]
		unknown := !states[id].Valid || states[id].Int64 < -1 || states[id].Int64 > 1
		for _, b := range item.Bindings {
			if b.State == "active" {
				item.State = "active_binding_observed"
				break
			}
			unknown = unknown || b.State == "unknown"
		}
		if item.State != "active_binding_observed" && readComplete && !unknown {
			item.State = "no_active_binding_observed"
		}
		if unknown {
			result.Complete = false
			result.Reason = "invalid_values"
		}
	}
	if e = tx.Commit(); e != nil {
		return result, safeReadError(e)
	}
	return result, nil
}

func safeIdentity(s string) bool {
	if !safeText(s, 512) || len(s) < 5 || !(strings.HasPrefix(s, "sip:") || strings.HasPrefix(s, "sips:") || strings.HasPrefix(s, "tel:")) || strings.ContainsAny(s, "<>\"? \t\r\n") {
		return false
	}
	if before, _, ok := strings.Cut(s, "@"); ok && strings.Contains(strings.TrimPrefix(strings.TrimPrefix(before, "sips:"), "sip:"), ":") {
		return false
	}
	return true
}
func safeContact(s string) string {
	s = strings.Trim(s, "<>")
	s = strings.SplitN(s, "?", 2)[0]
	s = strings.SplitN(s, ";", 2)[0]
	if !safeIdentity(s) {
		return ""
	}
	if before, _, ok := strings.Cut(s, "@"); ok && strings.Contains(strings.TrimPrefix(strings.TrimPrefix(before, "sips:"), "sip:"), ":") {
		return ""
	}
	return s
}

func (r *MySQLReader) Enrich(ctx context.Context, s Source, items []Identity) (string, error) {
	if s.HSS == nil || len(items) == 0 {
		return "not_configured", nil
	}
	db, e := r.pool(*s.HSS)
	if e != nil {
		return "unavailable", e
	}
	if e = requireReadOnly(ctx, db); e != nil {
		return "unavailable", e
	}
	tx, e := db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if e != nil {
		return "unavailable", safeReadError(e)
	}
	defer tx.Rollback()
	if e = validateSchema(ctx, tx, true); e != nil {
		return "unavailable", e
	}
	state := "ok"
	private, phones := map[string]map[string]bool{}, map[string]map[string]bool{}
	for start := 0; start < len(items); start += 50 {
		end := min(start+50, len(items))
		args := []any{}
		placeholders := []string{}
		for _, item := range items[start:end] {
			args = append(args, item.PublicIdentity)
			placeholders = append(placeholders, "?")
		}
		query := "SELECT u.identity,i.identity,p.identity FROM impu u JOIN impi_impu x ON x.id_impu=u.id JOIN impi i ON i.id=x.id_impi LEFT JOIN impi_impu y ON y.id_impi=i.id LEFT JOIN impu p ON p.id=y.id_impu AND p.identity LIKE 'tel:%' WHERE BINARY u.identity IN (" + strings.Join(placeholders, ",") + ") LIMIT 2001"
		rows, err := tx.QueryContext(ctx, query, args...)
		if err != nil {
			return "unavailable", safeReadError(err)
		}
		n := 0
		for rows.Next() {
			var identity, impi string
			var phone sql.NullString
			if rows.Scan(&identity, &impi, &phone) != nil {
				rows.Close()
				return "unavailable", &ReadError{"invalid_identity_response"}
			}
			n++
			if n > 2000 {
				state = "partial"
				break
			}
			if impi == "" || !safeText(impi, 255) {
				state = "partial"
				continue
			}
			if private[identity] == nil {
				private[identity] = map[string]bool{}
				phones[identity] = map[string]bool{}
			}
			if private[identity][impi] || len(private[identity]) < 16 {
				private[identity][impi] = true
			} else {
				state = "partial"
			}
			if phone.Valid {
				number := strings.TrimPrefix(phone.String, "tel:")
				if !validPhone(phone.String) || !phones[identity][number] && len(phones[identity]) >= 16 {
					state = "partial"
				} else {
					phones[identity][number] = true
				}
			}
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return "unavailable", safeReadError(err)
		}
	}
	if e = tx.Commit(); e != nil {
		return "unavailable", safeReadError(e)
	}
	for i := range items {
		items[i].PrivateIdentities = []string{}
		items[i].MSISDNs = []string{}
		items[i].IdentityState = "unmapped"
		if state == "partial" {
			items[i].IdentityState = "partial"
		}
		for v := range private[items[i].PublicIdentity] {
			items[i].PrivateIdentities = append(items[i].PrivateIdentities, v)
		}
		for v := range phones[items[i].PublicIdentity] {
			items[i].MSISDNs = append(items[i].MSISDNs, v)
		}
		sort.Strings(items[i].PrivateIdentities)
		sort.Strings(items[i].MSISDNs)
		if len(items[i].PrivateIdentities) > 0 {
			items[i].IdentityState = state
		}
		if len(items[i].PrivateIdentities) > 1 {
			items[i].IdentityState = "ambiguous"
			if state == "partial" {
				items[i].IdentityState = "ambiguous_partial"
			}
		}
	}
	return state, nil
}
func validPhone(s string) bool {
	if !strings.HasPrefix(s, "tel:") || len(s) < 7 || len(s) > 25 {
		return false
	}
	for i, c := range strings.TrimPrefix(s, "tel:") {
		if c == '+' && i == 0 {
			continue
		}
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}
