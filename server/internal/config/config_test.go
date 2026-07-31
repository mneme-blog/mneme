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
