// Command journald is the Mneme relay: a dumb, owner-scoped encrypted-blob store.
// It never sees plaintext, keys, or the mnemonic. See CLAUDE.md §1, §7.
//
// Subcommands:
//
//	journald [serve]              run the relay (default)
//	journald backup [--out path]  write one backup archive (BACKUP_DIR or --out)
//	journald restore <archive>    replace all relay data from an archive (DESTRUCTIVE)
//	journald list-backups         list archives in BACKUP_DIR
package main

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/mneme-blog/mneme/server/internal/api"
	"github.com/mneme-blog/mneme/server/internal/backup"
	"github.com/mneme-blog/mneme/server/internal/blobs"
	"github.com/mneme-blog/mneme/server/internal/config"
	"github.com/mneme-blog/mneme/server/internal/reminders"
	"github.com/mneme-blog/mneme/server/internal/store"
)

// version is the relay's build identifier, stamped at build time via
//
//	go build -ldflags "-X main.version=<tag>"
//
// (see server/Dockerfile and .github/workflows/release.yml). It defaults to
// "dev" for plain source builds. The admin dashboard reports it and compares it
// against the latest GitHub release.
var version = "dev"

func main() {
	if err := dispatch(os.Args[1:]); err != nil {
		log.Fatalf("journald: %v", err)
	}
}

func dispatch(args []string) error {
	cmd := "serve"
	if len(args) > 0 {
		cmd = args[0]
		args = args[1:]
	}
	switch cmd {
	case "serve":
		return runServer()
	case "backup":
		return cmdBackup(args)
	case "restore":
		return cmdRestore(args)
	case "list-backups":
		return cmdListBackups(args)
	case "healthcheck":
		return cmdHealthcheck(args)
	case "schema-info":
		return cmdSchemaInfo(args)
	case "version", "--version", "-v":
		fmt.Println(version)
		return nil
	case "-h", "--help", "help":
		usage()
		return nil
	default:
		usage()
		return fmt.Errorf("unknown command %q", cmd)
	}
}

func usage() {
	fmt.Fprint(os.Stderr, `journald — the Mneme relay

usage:
  journald [serve]              run the relay (default)
  journald backup [--out PATH]  write one backup archive to PATH, or into BACKUP_DIR
  journald restore ARCHIVE [--yes]
                                replace ALL relay data from ARCHIVE (destructive)
  journald list-backups         list archives in BACKUP_DIR
  journald healthcheck          probe /readyz on the local listener (container HEALTHCHECK)
  journald schema-info [--out PATH]
                                print this build's migration/rollback manifest as JSON
  journald version              print the build version

Backups archive every vault's opaque ciphertext + media chunks. They contain no
keys and no plaintext. Configure with BACKUP_DIR / BACKUP_INTERVAL / BACKUP_KEEP.
`)
}

func runServer() error {
	cfg := config.Load()
	cfg.Version = version

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// Connect + migrate (with a bounded startup window so a missing DB fails fast-ish).
	startCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	st, err := store.New(startCtx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer st.Close()

	if err := st.Migrate(startCtx); err != nil {
		return err
	}
	log.Printf("migrations applied")

	bl, err := blobs.New(cfg.S3)
	if err != nil {
		return err
	}
	if _, disabled := bl.(blobs.Disabled); disabled {
		log.Printf("media storage disabled (S3_ENDPOINT not set)")
	}

	apiSrv := api.New(st, bl, cfg)

	// Background workers, joined on shutdown: the usage flusher's final flush
	// and a backup mid-write must finish before the process exits — a naked
	// goroutine racing process teardown loses whatever it was writing.
	var workers sync.WaitGroup
	runWorker := func(fn func()) {
		workers.Add(1)
		go func() {
			defer workers.Done()
			fn()
		}()
	}
	runWorker(func() { reminders.NewScheduler(st, reminders.LogDispatcher{}, time.Minute).Run(ctx) })
	runWorker(func() { purgeLoop(ctx, st) })
	runWorker(func() { apiSrv.RunUsageFlusher(ctx, 30*time.Second) })
	runWorker(func() { apiSrv.RunBackups(ctx) })

	if cfg.AdminToken != "" {
		log.Printf("admin dashboard enabled at /admin")
	}
	if cfg.Backup.Dir == "" {
		log.Printf("scheduled backups disabled (BACKUP_DIR not set)")
	}
	// Say the transcription policy out loud. The numbers are per vault per day
	// and the units are in the variable names, because "50" alone could as
	// easily mean minutes of audio or words of transcript as recordings.
	log.Printf("%s", cfg.Transcribe.Summary())
	// Safe today — auth is a Bearer header and no cookie is ever set, so a
	// reflected origin buys a cross-origin page nothing. Still worth saying out
	// loud: it is the most permissive setting there is, and it is only one
	// future `Allow-Credentials` away from being an account-takeover bug.
	if strings.TrimSpace(cfg.CORSOrigins) == "*" {
		log.Printf("WARNING: CORS_ORIGINS is \"*\" — any origin is reflected. " +
			"Set it to your client origin(s), or \"\" for a same-origin deployment.")
	}

	// Timeouts, all of them. decodeJSON caps body SIZE (32 MiB) but not
	// duration, so without these a client can trickle a body forever or park
	// idle keep-alives and exhaust connections (slowloris).
	//
	// The read/write budgets are generous on purpose: a 32 MiB blob batch or a
	// backup archive download over a slow link is legitimate traffic, and a
	// timeout that cuts those off is a bug, not a defence.
	srv := &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           apiSrv.Routes(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       2 * time.Minute,
		WriteTimeout:      5 * time.Minute,
		IdleTimeout:       2 * time.Minute,
	}

	// Serve until a signal arrives, then drain gracefully.
	serveErr := make(chan error, 1)
	go func() {
		log.Printf("listening on %s", cfg.ListenAddr)
		serveErr <- srv.ListenAndServe()
	}()

	select {
	case err := <-serveErr:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-ctx.Done():
		log.Printf("shutting down")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		err := srv.Shutdown(shutdownCtx)
		// The workers see the same ctx cancellation; wait for their final
		// writes (usage flush, an in-flight backup) before returning.
		workers.Wait()
		return err
	}
}

// purgeLoop periodically clears expired auth challenges and sessions.
func purgeLoop(ctx context.Context, st *store.Store) {
	ticker := time.NewTicker(15 * time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := st.PurgeExpired(ctx); err != nil {
				log.Printf("purge expired: %v", err)
			}
		}
	}
}

// ── CLI: backup / restore / list-backups ────────────────────────────────────
//
// These connect to the same Postgres + object storage the server uses, so they read
// their configuration from the same environment. Restore is the recommended path for
// real disaster recovery: it can run against a stopped or freshly-provisioned server.

// openDeps connects the store and object storage for a one-shot CLI command. When
// migrate is true the schema is brought to head first (needed before a restore so
// the target tables exist).
func openDeps(ctx context.Context, cfg config.Config, migrate bool) (*store.Store, blobs.Store, error) {
	st, err := store.New(ctx, cfg.DatabaseURL)
	if err != nil {
		return nil, nil, err
	}
	if migrate {
		if err := st.Migrate(ctx); err != nil {
			st.Close()
			return nil, nil, err
		}
	}
	bl, err := blobs.New(cfg.S3)
	if err != nil {
		st.Close()
		return nil, nil, err
	}
	return st, bl, nil
}

func cmdBackup(args []string) error {
	fs := flag.NewFlagSet("backup", flag.ContinueOnError)
	out := fs.String("out", "", "write the archive to this path instead of BACKUP_DIR")
	if err := fs.Parse(args); err != nil {
		return err
	}
	cfg := config.Load()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()

	st, bl, err := openDeps(ctx, cfg, false)
	if err != nil {
		return err
	}
	defer st.Close()

	// Explicit --out path: write straight there. Otherwise use the managed dir.
	if *out != "" {
		f, err := os.OpenFile(*out, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err != nil {
			return fmt.Errorf("create %s: %w", *out, err)
		}
		man, werr := backup.Create(ctx, st, bl, f)
		if cerr := f.Close(); werr == nil {
			werr = cerr
		}
		if werr != nil {
			_ = os.Remove(*out)
			return werr
		}
		fmt.Printf("wrote %s — %s\n", *out, summarize(man))
		return nil
	}

	svc := backup.NewService(cfg.Backup.Dir, cfg.Backup.Keep, st, bl)
	rec, err := svc.RunNow(ctx)
	if err != nil {
		if errors.Is(err, backup.ErrDisabled) {
			return errors.New("set BACKUP_DIR or pass --out PATH")
		}
		return err
	}
	fmt.Printf("wrote %s/%s (%d bytes)\n", cfg.Backup.Dir, rec.Name, rec.Bytes)
	return nil
}

func cmdRestore(args []string) error {
	fs := flag.NewFlagSet("restore", flag.ContinueOnError)
	yes := fs.Bool("yes", false, "skip the confirmation prompt")
	// Accept the ARCHIVE positional before or after the flag — flag.Parse stops at
	// the first non-flag, so loop, peeling off positionals and re-parsing the rest.
	var positionals []string
	for rest := args; ; {
		if err := fs.Parse(rest); err != nil {
			return err
		}
		if fs.NArg() == 0 {
			break
		}
		positionals = append(positionals, fs.Arg(0))
		rest = fs.Args()[1:]
	}
	if len(positionals) != 1 {
		return errors.New("usage: journald restore ARCHIVE [--yes]")
	}
	archive := positionals[0]
	cfg := config.Load()

	if !*yes {
		fmt.Printf("This REPLACES all data in %s with the contents of %s.\n", redactDSN(cfg.DatabaseURL), archive)
		fmt.Print("Type 'restore' to continue: ")
		line, _ := bufio.NewReader(os.Stdin).ReadString('\n')
		if strings.TrimSpace(line) != "restore" {
			return errors.New("aborted")
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()

	st, bl, err := openDeps(ctx, cfg, true)
	if err != nil {
		return err
	}
	defer st.Close()

	f, err := os.Open(archive)
	if err != nil {
		return err
	}
	defer f.Close() //nolint:errcheck // read-only stream

	man, err := backup.Restore(ctx, st, bl, f)
	if err != nil {
		return err
	}
	fmt.Printf("restored from %s — %s\n", archive, summarize(man))
	return nil
}

func cmdListBackups(args []string) error {
	if len(args) > 0 {
		return errors.New("usage: journald list-backups")
	}
	cfg := config.Load()
	if cfg.Backup.Dir == "" {
		return errors.New("BACKUP_DIR not set")
	}
	svc := backup.NewService(cfg.Backup.Dir, cfg.Backup.Keep, nil, nil)
	recs, err := svc.List()
	if err != nil {
		return err
	}
	if len(recs) == 0 {
		fmt.Printf("no backups in %s\n", cfg.Backup.Dir)
		return nil
	}
	for _, r := range recs {
		fmt.Printf("%s\t%10d bytes\t%s\n", r.Name, r.Bytes, r.CreatedAt.Format(time.RFC3339))
	}
	return nil
}

func summarize(m *backup.Manifest) string {
	c := m.Counts
	return fmt.Sprintf("%d vaults, %d devices, %d entries, %d media (%d bytes), %d reminders",
		c.Owners, c.Devices, c.Entries, c.Media, m.MediaBytes, c.Reminders)
}

// redactDSN strips any password from a Postgres URL for display.
func redactDSN(dsn string) string {
	at := strings.LastIndexByte(dsn, '@')
	scheme := strings.Index(dsn, "://")
	if at < 0 || scheme < 0 {
		return dsn
	}
	return dsn[:scheme+3] + "…@" + dsn[at+1:]
}
