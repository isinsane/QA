// Command migrate applies or rolls back schema migrations.
//
//	go run ./cmd/migrate up
//	go run ./cmd/migrate down
package main

import (
	"context"
	"fmt"
	"os"

	"github.com/joho/godotenv"

	"github.com/oaldesi/qa-portal/internal/config"
	"github.com/oaldesi/qa-portal/internal/db"
)

func main() {
	_ = godotenv.Load()
	if len(os.Args) < 2 || (os.Args[1] != "up" && os.Args[1] != "down") {
		fmt.Fprintln(os.Stderr, "usage: migrate <up|down>")
		os.Exit(2)
	}
	cfg, err := config.Load()
	if err == nil {
		err = db.Migrate(context.Background(), cfg.DatabaseURL, os.Args[1] == "down")
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "migrate: %v\n", err)
		os.Exit(1)
	}
	fmt.Println("migrate", os.Args[1], "done")
}
