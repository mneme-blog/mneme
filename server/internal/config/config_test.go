package config

import "testing"

// CORS_ORIGINS is the one setting where "unset" and "set to empty" must mean
// different things: unset = no preference (dev default "*"), empty = allow no
// cross-origin caller at all. Reading it through the ordinary empty-means-unset
// helper made docker-compose.prod.yml's `CORS_ORIGINS: ""` silently fall
// through to "*", i.e. a production relay reflecting any origin.
func TestCORSOriginsDistinguishesEmptyFromUnset(t *testing.T) {
	t.Run("unset falls back to the default", func(t *testing.T) {
		t.Setenv("SOME_UNSET_KEY_FOR_TEST", "") // ensure a clean env for the subtest
		if got := envAllowEmpty("MNEME_TEST_CORS_UNSET", "*"); got != "*" {
			t.Fatalf("unset = %q, want the default %q", got, "*")
		}
	})

	t.Run("explicitly empty stays empty", func(t *testing.T) {
		t.Setenv("MNEME_TEST_CORS_EMPTY", "")
		if got := envAllowEmpty("MNEME_TEST_CORS_EMPTY", "*"); got != "" {
			t.Fatalf("explicit empty = %q, want %q — an empty allowlist must not become reflect-any", got, "")
		}
	})

	t.Run("a real value passes through", func(t *testing.T) {
		t.Setenv("MNEME_TEST_CORS_SET", "https://mneme.example")
		if got := envAllowEmpty("MNEME_TEST_CORS_SET", "*"); got != "https://mneme.example" {
			t.Fatalf("set = %q", got)
		}
	})
}

// Load must wire that behaviour through, not just the helper.
func TestLoadHonoursEmptyCORSOrigins(t *testing.T) {
	t.Setenv("CORS_ORIGINS", "")
	if got := Load().CORSOrigins; got != "" {
		t.Fatalf("Load with CORS_ORIGINS=\"\" gave %q, want an empty allowlist", got)
	}
}

// Invalid env values must fall back to the default (with a warning) rather
// than being half-accepted: a fat-fingered quota silently becoming "unlimited"
// and a negative SESSION_TTL minting already-expired sessions both shipped
// before these guards existed.
func TestEnvParsersRejectGarbage(t *testing.T) {
	t.Run("duration", func(t *testing.T) {
		t.Setenv("MNEME_TEST_DUR", "24hours")
		if got := envDuration("MNEME_TEST_DUR", 42); got != 42 {
			t.Fatalf("garbage duration = %v, want default", got)
		}
		t.Setenv("MNEME_TEST_DUR", "-5m")
		if got := envDuration("MNEME_TEST_DUR", 42); got != 42 {
			t.Fatalf("negative duration = %v, want default", got)
		}
		t.Setenv("MNEME_TEST_DUR", "30m")
		if got := envDuration("MNEME_TEST_DUR", 42); got.Minutes() != 30 {
			t.Fatalf("valid duration = %v", got)
		}
	})

	t.Run("int", func(t *testing.T) {
		t.Setenv("MNEME_TEST_INT", "seven")
		if got := envInt("MNEME_TEST_INT", 7); got != 7 {
			t.Fatalf("garbage int = %d, want default", got)
		}
		t.Setenv("MNEME_TEST_INT", "-3")
		if got := envInt("MNEME_TEST_INT", 7); got != 7 {
			t.Fatalf("negative int = %d, want default", got)
		}
	})

	t.Run("int64", func(t *testing.T) {
		t.Setenv("MNEME_TEST_INT64", "10GB")
		if got := envInt64("MNEME_TEST_INT64", 99); got != 99 {
			t.Fatalf("garbage int64 = %d, want default — 10GB must not mean unlimited", got)
		}
	})

	t.Run("bool", func(t *testing.T) {
		// The old switch treated ANY unrecognized value as true — the
		// asymmetric direction ("flase" enabling a switch).
		t.Setenv("MNEME_TEST_BOOL", "flase")
		if got := envBool("MNEME_TEST_BOOL", false); got != false {
			t.Fatal("typo'd bool must fall back to the default, not true")
		}
		t.Setenv("MNEME_TEST_BOOL", "yes")
		if !envBool("MNEME_TEST_BOOL", false) {
			t.Fatal("'yes' should be true")
		}
		t.Setenv("MNEME_TEST_BOOL", "off")
		if envBool("MNEME_TEST_BOOL", true) {
			t.Fatal("'off' should be false")
		}
	})
}
