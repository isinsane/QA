// Package migrations embeds the goose SQL files so binaries can migrate
// without the source tree on disk.
package migrations

import "embed"

//go:embed *.sql
var FS embed.FS
