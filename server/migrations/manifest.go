package migrations

import (
	"bufio"
	"bytes"
	"fmt"
	"io/fs"
	"sort"
	"strconv"
	"strings"
)

// The rollback contract.
//
// Migrations are forward-only (§11): there are no down migrations, and there
// never will be. That is fine going forward and awkward going backward — the
// one-click updater in /admin offers to roll a bad release back, and rolling the
// *binary* back to N-1 leaves the *schema* at N.
//
// Whether that is survivable depends entirely on what the migration did:
//
//	safe     — purely additive (new table, new column with a default, new index).
//	           The previous release simply never selects the new thing, so it runs
//	           against the newer schema untouched. Rollback is an image swap.
//	breaking — anything the previous release cannot tolerate: dropping or renaming
//	           a column it still reads, narrowing a type, adding a NOT NULL column
//	           without a default that it never writes, moving data out of a table
//	           it queries. Rolling back past this needs the database rebuilt at the
//	           old schema and repopulated from a backup archive.
//
// Every migration must declare which it is, on its own line, anywhere in the
// leading comment block:
//
//	-- rollback: safe
//
// This is not decoration. The release workflow bakes the parsed result into the
// release's mneme-release.json asset, and the updater reads it to decide whether
// "rollback to the previous version" is a 20-second image swap or a destructive
// restore — and to say so honestly in the dashboard before the operator commits.
// A missing or unknown marker is a build failure (Validate), not a default,
// because a silently-assumed "safe" is exactly the answer that loses data.

// Rollback classifications.
const (
	RollbackSafe     = "safe"
	RollbackBreaking = "breaking"
)

// Migration is one forward-only step plus its rollback classification.
type Migration struct {
	Version  int    `json:"version"`
	Name     string `json:"name"`
	Rollback string `json:"rollback"`
}

// Manifest describes the schema this binary carries. It is what the updater and
// the dashboard reason about; see MinSafeSchema for the load-bearing field.
type Manifest struct {
	// Schema is the highest migration version compiled in — the schema head this
	// build migrates the database to on startup.
	Schema int `json:"schema"`
	// MinSafeSchema is the oldest schema head a *previous* release may have and
	// still run correctly against this build's database. It is the version of the
	// newest breaking migration, or 0 when every migration is additive.
	//
	// Rolling back to a release whose Schema is >= MinSafeSchema is a plain image
	// swap. Below it, the old binary would meet a schema it cannot read, and the
	// only correct path is rebuild-and-restore.
	MinSafeSchema int         `json:"min_safe_schema"`
	Migrations    []Migration `json:"migrations"`
}

// List returns every embedded migration in version order, with its declared
// rollback classification. An undeclared or unrecognised marker is an error.
func List() ([]Migration, error) {
	files, err := fs.Glob(FS, "*.sql")
	if err != nil {
		return nil, fmt.Errorf("list migrations: %w", err)
	}
	sort.Strings(files)

	out := make([]Migration, 0, len(files))
	for _, name := range files {
		version, err := versionOf(name)
		if err != nil {
			return nil, err
		}
		body, err := FS.ReadFile(name)
		if err != nil {
			return nil, fmt.Errorf("read %s: %w", name, err)
		}
		kind, err := rollbackMarker(body)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", name, err)
		}
		out = append(out, Migration{Version: version, Name: name, Rollback: kind})
	}
	return out, nil
}

// Describe builds the manifest for the embedded migration set.
func Describe() (Manifest, error) {
	list, err := List()
	if err != nil {
		return Manifest{}, err
	}
	m := Manifest{Migrations: list}
	for _, mig := range list {
		if mig.Version > m.Schema {
			m.Schema = mig.Version
		}
		if mig.Rollback == RollbackBreaking && mig.Version > m.MinSafeSchema {
			m.MinSafeSchema = mig.Version
		}
	}
	return m, nil
}

// Validate fails if any migration is missing its rollback marker. Called from a
// test so an undeclared migration cannot reach a release.
func Validate() error {
	_, err := List()
	return err
}

// rollbackMarker extracts the "-- rollback: <kind>" declaration. Only comment
// lines are scanned: the marker must be in the header, not buried in DDL, and
// scanning stops at the first non-comment, non-blank line so a stray match
// inside a string literal cannot be mistaken for the declaration.
func rollbackMarker(body []byte) (string, error) {
	sc := bufio.NewScanner(bytes.NewReader(body))
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		if !strings.HasPrefix(line, "--") {
			break // past the header comment block
		}
		rest := strings.TrimSpace(strings.TrimPrefix(line, "--"))
		const key = "rollback:"
		if !strings.HasPrefix(strings.ToLower(rest), key) {
			continue
		}
		// Only the first word is the classification; the rest of the line is
		// free-form justification ("safe — additive only"), which is where the
		// reasoning belongs and should not have to be omitted to satisfy a parser.
		fields := strings.Fields(strings.ToLower(rest[len(key):]))
		if len(fields) == 0 {
			return "", fmt.Errorf("empty rollback marker (want %q or %q)", RollbackSafe, RollbackBreaking)
		}
		switch kind := fields[0]; kind {
		case RollbackSafe, RollbackBreaking:
			return kind, nil
		default:
			return "", fmt.Errorf("unknown rollback marker %q (want %q or %q)", kind, RollbackSafe, RollbackBreaking)
		}
	}
	if err := sc.Err(); err != nil {
		return "", err
	}
	return "", fmt.Errorf(`missing "-- rollback: safe" or "-- rollback: breaking" declaration in the header comment`)
}

// versionOf parses the leading integer of a filename like "0001_init.sql".
func versionOf(name string) (int, error) {
	base := name
	if i := strings.IndexByte(base, '_'); i >= 0 {
		base = base[:i]
	} else {
		base = strings.TrimSuffix(base, ".sql")
	}
	v, err := strconv.Atoi(base)
	if err != nil {
		return 0, fmt.Errorf("migration %q has no leading version number: %w", name, err)
	}
	return v, nil
}
