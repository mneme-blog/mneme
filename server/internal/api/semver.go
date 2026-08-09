package api

// Pure version-string logic for the update check: semver ordering, git-describe
// parsing, and build↔commit matching. Split from version.go (which owns the
// GitHub client + cache + handler) so the comparison rules are readable — and
// testable — on their own.

import (
	"regexp"
	"strconv"
	"strings"
)

// buildCommitRe extracts the commit a build was made from: either a CI main
// build ("main-<sha>", the image tag) or a source build stamped by git describe
// ("v0.2.1-3-g<sha>", optionally "-dirty").
var buildCommitRe = regexp.MustCompile(`(?:^main-|-g)([0-9a-f]{7,40})(?:-dirty)?$`)

// buildMatchesCommit reports whether the running build is the given commit.
// Shas are compared as prefixes (short vs. full); a build whose commit cannot
// be extracted (a bare release tag, "dev") never matches.
func buildMatchesCommit(current, sha string) bool {
	m := buildCommitRe.FindStringSubmatch(current)
	if m == nil {
		return false
	}
	a, b := m[1], sha
	if len(a) > len(b) {
		a, b = b, a
	}
	return strings.HasPrefix(b, a)
}

func isHex(s string) bool {
	for _, r := range s {
		if (r < '0' || r > '9') && (r < 'a' || r > 'f') {
			return false
		}
	}
	return true
}

// describeRe splits a `git describe --tags` build stamp into the tag it was cut
// from and the number of commits made since: "v0.2.1-6-g31eddf5" → ("v0.2.1", 6).
var describeRe = regexp.MustCompile(`^(v?\d+\.\d+\.\d+)-(\d+)-g[0-9a-f]{7,40}(?:-dirty)?$`)

// aheadOfRelease reports whether the running build is newer than the latest
// release. Two shapes count: a build stamped past the tag (git describe leaves
// the commits-since count in the version string), and a build of a tag that is
// itself higher than the newest published release. Anything whose position
// cannot be established — a main-<sha> image, "dev", an unparseable release
// feed — is not "ahead"; it is simply unknown, and the caller keeps its
// neutral wording.
func aheadOfRelease(current, latest string) bool {
	if _, ok := parseSemver(latest); !ok {
		return false
	}
	base, ahead := current, 0
	if m := describeRe.FindStringSubmatch(strings.TrimSpace(current)); m != nil {
		base = m[1]
		ahead, _ = strconv.Atoi(m[2])
	}
	if _, ok := parseSemver(base); !ok {
		return false
	}
	switch {
	case semverLess(latest, base):
		return true // built from a tag newer than the newest release
	case semverLess(base, latest):
		return false // behind the release — a genuine update
	default:
		return ahead > 0 // same tag; ahead only if commits were made past it
	}
}

// semverLess reports whether a is an older release than b. Both must be valid
// vMAJOR.MINOR.PATCH tags; anything unparseable (e.g. a "dev" build) yields
// false, so development builds are never nagged.
func semverLess(a, b string) bool {
	av, aok := parseSemver(a)
	bv, bok := parseSemver(b)
	if !aok || !bok {
		return false
	}
	for i := 0; i < 3; i++ {
		if av[i] != bv[i] {
			return av[i] < bv[i]
		}
	}
	return false
}

// parseSemver reads a vMAJOR.MINOR.PATCH tag, ignoring any prerelease ("-...")
// or metadata ("+...") suffix. Returns ok=false on anything else.
func parseSemver(s string) ([3]int, bool) {
	s = strings.TrimSpace(s)
	s = strings.TrimPrefix(s, "v")
	if i := strings.IndexAny(s, "-+"); i >= 0 {
		s = s[:i]
	}
	parts := strings.Split(s, ".")
	if len(parts) != 3 {
		return [3]int{}, false
	}
	var out [3]int
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 {
			return [3]int{}, false
		}
		out[i] = n
	}
	return out, true
}
