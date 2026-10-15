// Command api serves the QA portal: JSON API, the built web app (WEB_DIR),
// and the background loops (assignment pass, daily ticket pull). Migrations
// run on start.
package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/google/uuid"
	"github.com/joho/godotenv"

	"github.com/oaldesi/qa-portal/internal/assign"
	"github.com/oaldesi/qa-portal/internal/config"
	"github.com/oaldesi/qa-portal/internal/db"
	"github.com/oaldesi/qa-portal/internal/edesk"
	"github.com/oaldesi/qa-portal/internal/httpapi"
	"github.com/oaldesi/qa-portal/internal/importer"
	"github.com/oaldesi/qa-portal/internal/model"
	"github.com/oaldesi/qa-portal/internal/qaapi"
	"github.com/oaldesi/qa-portal/internal/rotation"
)

func main() {
	_ = godotenv.Load()
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "api: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := db.Migrate(ctx, cfg.DatabaseURL, false); err != nil {
		return err
	}
	gdb, err := db.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}

	runner := assign.NewRunner(gdb)
	assignPass := func(ctx context.Context) error {
		err := runner.Run(ctx)
		if err != nil {
			log.Printf("assign: %v", err)
		}
		return err
	}
	opts := httpapi.Options{WebDir: cfg.WebDir, AssignPass: assignPass}
	rotations := rotation.NewRunner(gdb)

	var ed *edesk.Client
	if cfg.EDeskToken != "" {
		ed = edesk.New(cfg.EDeskToken)
		opts.EDeskTicket = ed.Ticket
	}
	if cfg.QAAPIKey != "" && cfg.QAAPIBaseURL != "" {
		client := qaapi.New(cfg.QAAPIBaseURL, cfg.QAAPIKey)
		if ed != nil {
			client.TagNames = ed.Tags
		}
		opts.TicketsPull = func(ctx context.Context, tt model.TaskType, day model.Date, userID *uuid.UUID) (*importer.Result, error) {
			return qaapi.Pull(ctx, gdb, client, tt, day, userID)
		}
		go qaapi.Daily(ctx, gdb, client, func() { _ = assignPass(ctx) })
	} else {
		log.Print("QA_API_KEY or QA_API_BASE_URL not set: ticket pull disabled")
	}

	go func() {
		tick := time.NewTicker(time.Minute)
		defer tick.Stop()
		for {
			if err := rotations.Run(ctx); err != nil {
				log.Printf("rotation: %v", err)
			}
			_ = assignPass(ctx)
			select {
			case <-ctx.Done():
				return
			case <-tick.C:
			}
		}
	}()

	srv := &http.Server{Addr: cfg.HTTPAddr, Handler: httpapi.NewServer(gdb, opts).Handler(), ReadHeaderTimeout: 10 * time.Second}
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdown)
	}()
	log.Printf("api listening on %s", cfg.HTTPAddr)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		return err
	}
	return nil
}
