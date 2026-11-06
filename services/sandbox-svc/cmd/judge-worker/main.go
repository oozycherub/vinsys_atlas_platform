// judge-worker pulls jobs fairly and judges them in isolate boxes. It runs in a gVisor pod on
// the tainted sandbox node pool, one Deployment per language image (infra/k8s/sandbox).
package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"atlas.dev/sandbox-svc/internal/adapters/blob"
	"atlas.dev/sandbox-svc/internal/adapters/isolate"
	"atlas.dev/sandbox-svc/internal/adapters/postgres"
	"atlas.dev/sandbox-svc/internal/app"
	"atlas.dev/sandbox-svc/internal/config"
	"atlas.dev/sandbox-svc/internal/domain"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.FromOS(true)
	if err != nil {
		return err
	}
	log := config.Logger(cfg, "judge-worker").With("worker_id", cfg.WorkerID)
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	store, err := postgres.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer store.Close()
	blobs, err := config.Blobs(cfg)
	if err != nil {
		return err
	}
	var all []domain.Language
	if err := store.InSystem(ctx, func(r app.SystemRepo) (err error) { all, err = r.Languages(ctx); return err }); err != nil {
		return err
	}
	served := config.ServedLanguages(all, cfg.WorkerLanguages, cfg.ImageDigest, log)
	if len(served) == 0 {
		return errors.New("this worker serves no registry language (check ATLAS_JUDGE_LANGUAGES and the image digest)")
	}
	pool, err := isolate.NewPool(ctx, isolate.Config{Bin: cfg.IsolateBin, CgroupRoot: cfg.CgroupRoot, ExtraDirs: cfg.ExtraDirs},
		cfg.BoxFirstID, cfg.BoxPoolSize, os.TempDir())
	if err != nil {
		return fmt.Errorf("isolate box pool: %w", err)
	}
	defer pool.Close()

	worker := &app.Worker{
		ID: cfg.WorkerID, Store: store, Bundles: &blob.Cache{Store: blobs, Dir: cfg.CacheDir},
		Judge: &app.Judge{Pool: pool}, Clock: app.SystemClock{}, Log: log, Languages: served,
	}
	// Probes: alive while the process runs; ready while boxes are available and the DB answers.
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(200) })
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, r *http.Request) {
		if pool.Size() == 0 || store.Ping(r.Context()) != nil {
			w.WriteHeader(503)
			return
		}
		w.WriteHeader(200)
	})
	health := &http.Server{Addr: ":" + strconv.Itoa(cfg.HealthPort), Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	go func() { _ = health.ListenAndServe() }()
	defer health.Close()

	log.Info("judge worker started", "languages", cfg.WorkerLanguages, "boxes", cfg.BoxPoolSize)
	// One loop per two boxes (a custom checker needs a second box). Each loop owns its copy of
	// the worker, because the fair schedulers are not safe for concurrent use.
	done := make(chan struct{})
	for i := 0; i < cfg.BoxPoolSize/2; i++ {
		w := *worker
		go func() {
			w.Run(ctx, 200*time.Millisecond)
			done <- struct{}{}
		}()
	}
	for i := 0; i < cfg.BoxPoolSize/2; i++ {
		<-done
	}
	return nil
}
