package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/plasticparticle/mneme/server/internal/config"
	"github.com/plasticparticle/mneme/server/migrations"
)

// Two small subcommands that exist for the update pipeline.
//
// Both are here rather than in a script because the runtime image is distroless:
// there is no shell, no curl, no wget. The only executable in the container is
// this binary, so anything the container must be able to do about itself — prove
// it is healthy, describe its schema — has to be a subcommand.

// cmdHealthcheck probes the relay's own readiness endpoint and exits non-zero if
// it is not ready. This is the container HEALTHCHECK, and therefore the signal
// the updater's health gate waits on: "ready" means the process is up AND it
// reached Postgres, which is exactly what a successful migration looks like from
// the outside. A new release that fails to migrate never reports healthy, so it
// gets rolled back instead of silently serving errors.
func cmdHealthcheck(args []string) error {
	if len(args) > 0 {
		return errors.New("usage: journald healthcheck")
	}
	cfg := config.Load()

	// LISTEN_ADDR is typically ":8080" — a bind spec, not a dial target. Probe
	// loopback inside the container rather than whatever it binds publicly.
	_, port, err := net.SplitHostPort(cfg.ListenAddr)
	if err != nil {
		return fmt.Errorf("cannot derive a probe address from LISTEN_ADDR %q: %w", cfg.ListenAddr, err)
	}
	if port == "" {
		return fmt.Errorf("LISTEN_ADDR %q has no port", cfg.ListenAddr)
	}

	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get("http://127.0.0.1:" + port + "/readyz")
	if err != nil {
		return fmt.Errorf("not ready: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("not ready: %s", resp.Status)
	}
	return nil
}

// cmdSchemaInfo prints this build's schema manifest as JSON. The release workflow
// runs it and attaches the output as the release's mneme-release.json asset, which
// is how a *running* relay can find out, before applying an update, whether that
// update would be reversible by an image swap or would need a restore.
//
// Emitting it from the binary rather than parsing SQL in CI keeps one parser
// (migrations.Describe) authoritative for the answer.
func cmdSchemaInfo(args []string) error {
	fs := flag.NewFlagSet("schema-info", flag.ContinueOnError)
	out := fs.String("out", "", "write to this path instead of stdout")
	if err := fs.Parse(args); err != nil {
		return err
	}

	m, err := migrations.Describe()
	if err != nil {
		return err
	}
	payload := struct {
		Version string `json:"version"`
		migrations.Manifest
	}{Version: version, Manifest: m}

	body, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return err
	}
	body = append(body, '\n')

	if strings.TrimSpace(*out) == "" {
		_, err = os.Stdout.Write(body)
		return err
	}
	return os.WriteFile(*out, body, 0o644)
}
