// Command set-password is the bootstrap: it sets a user's password from the
// server, creating an admin when the email is new. A fresh install has no
// other way in.
//
//	go run ./cmd/set-password -email you@company.com -name "Your Name"
package main

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"strings"

	"github.com/joho/godotenv"

	"github.com/oaldesi/qa-portal/internal/authn"
	"github.com/oaldesi/qa-portal/internal/config"
	"github.com/oaldesi/qa-portal/internal/db"
	"github.com/oaldesi/qa-portal/internal/model"
)

func main() {
	_ = godotenv.Load()
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "set-password: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	email := flag.String("email", "", "the user's email")
	name := flag.String("name", "", "name for a new admin (only used when the email is new)")
	password := flag.String("password", "", "new password; omit to be prompted")
	flag.Parse()
	if strings.TrimSpace(*email) == "" {
		return errors.New("usage: set-password -email <address> [-name <name>] [-password <pw>]")
	}
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	ctx := context.Background()
	if err := db.Migrate(ctx, cfg.DatabaseURL, false); err != nil {
		return err
	}
	gdb, err := db.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}

	var u model.User
	if gdb.Where("lower(email) = lower(?)", strings.TrimSpace(*email)).First(&u).Error != nil {
		if strings.TrimSpace(*name) == "" {
			return errors.New("no user with that email; pass -name to create an admin")
		}
		e := strings.TrimSpace(*email)
		u = model.User{Name: strings.TrimSpace(*name), Email: &e, Role: model.RoleAdmin, Active: true, IsAvailable: true}
		if err := gdb.Create(&u).Error; err != nil {
			return err
		}
		fmt.Println("created admin", e)
	}

	pw := *password
	if pw == "" {
		fmt.Print("New password: ")
		line, _ := bufio.NewReader(os.Stdin).ReadString('\n')
		pw = strings.TrimSpace(line)
	}
	if _, err := authn.NewService(gdb).SetPassword(ctx, u.ID, pw, false); err != nil {
		return err
	}
	fmt.Println("password set for", *u.Email)
	return nil
}
