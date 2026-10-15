// Package config loads runtime configuration from the environment.
package config

import (
	"fmt"
	"os"
	"strings"
)

type Config struct {
	Env         string
	DatabaseURL string
	HTTPAddr    string

	// WebDir is the built React app (web/dist), served on the API's own port
	// in production. Empty in dev, where Vite serves it and proxies /api.
	WebDir string

	// Clocks, the ticket pull hour and the like are admin settings now
	// (internal/settings); only secrets and endpoints stay here.
	QAAPIBaseURL string
	QAAPIKey     string

	EDeskToken string
}

func Load() (Config, error) {
	cfg := Config{
		Env:          env("APP_ENV", "dev"),
		DatabaseURL:  env("DATABASE_URL", ""),
		HTTPAddr:     env("HTTP_ADDR", ":8090"),
		WebDir:       env("WEB_DIR", ""),
		QAAPIBaseURL: strings.TrimRight(env("QA_API_BASE_URL", ""), "/"),
		QAAPIKey:     env("QA_API_KEY", ""),
		EDeskToken:   env("EDESK_API_TOKEN", ""),
	}
	if cfg.DatabaseURL == "" {
		return cfg, fmt.Errorf("config: DATABASE_URL is required")
	}
	return cfg, nil
}

func env(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}
