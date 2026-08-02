package migrations

import "testing"

// Every embedded migration must declare its rollback classification. This test
// is the enforcement point for the contract documented in manifest.go: adding a
// migration without a "-- rollback:" marker fails CI, so the updater is never
// left guessing whether a rollback needs a restore.
func TestEveryMigrationDeclaresRollbackSafety(t *testing.T) {
	if err := Validate(); err != nil {
		t.Fatalf("migration rollback markers: %v", err)
	}
}

func TestDescribe(t *testing.T) {
	m, err := Describe()
	if err != nil {
		t.Fatalf("Describe: %v", err)
	}
	if len(m.Migrations) == 0 {
		t.Fatal("no migrations embedded")
	}
	if m.Schema != m.Migrations[len(m.Migrations)-1].Version {
		t.Fatalf("Schema %d is not the last migration version %d", m.Schema, m.Migrations[len(m.Migrations)-1].Version)
	}
	// MinSafeSchema must be the newest breaking migration, or 0 when all additive.
	want := 0
	for _, mig := range m.Migrations {
		if mig.Rollback == RollbackBreaking && mig.Version > want {
			want = mig.Version
		}
	}
	if m.MinSafeSchema != want {
		t.Fatalf("MinSafeSchema = %d, want %d", m.MinSafeSchema, want)
	}
}

func TestVersionOf(t *testing.T) {
	cases := map[string]int{
		"0001_init.sql":          1,
		"0002_add_templates.sql": 2,
		"0042_whatever.sql":      42,
		"10.sql":                 10,
	}
	for name, want := range cases {
		got, err := versionOf(name)
		if err != nil {
			t.Fatalf("versionOf(%q) error: %v", name, err)
		}
		if got != want {
			t.Fatalf("versionOf(%q) = %d, want %d", name, got, want)
		}
	}

	if _, err := versionOf("nope.sql"); err == nil {
		t.Fatal("versionOf(\"nope.sql\") should error on missing version number")
	}
}

func TestRollbackMarker(t *testing.T) {
	tests := []struct {
		name string
		body string
		want string
		bad  bool
	}{
		{name: "safe", body: "-- header\n-- rollback: safe\nCREATE TABLE x();", want: RollbackSafe},
		{name: "breaking", body: "-- rollback: breaking\nALTER TABLE x DROP COLUMN y;", want: RollbackBreaking},
		{name: "case insensitive", body: "-- Rollback: SAFE\n", want: RollbackSafe},
		{name: "trailing prose", body: "-- rollback: safe — additive only\n", want: RollbackSafe},
		{name: "missing", body: "-- just a comment\nCREATE TABLE x();", bad: true},
		{name: "unknown kind", body: "-- rollback: maybe\n", bad: true},
		// The marker must be in the header block; a match after DDL has begun is
		// not a declaration (it could be inside a string literal or a later note).
		{name: "after ddl", body: "-- header\nCREATE TABLE x();\n-- rollback: safe\n", bad: true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := rollbackMarker([]byte(tc.body))
			if tc.bad {
				if err == nil {
					t.Fatalf("expected an error, got %q", got)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tc.want {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
		})
	}
}
