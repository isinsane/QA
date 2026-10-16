package importer

import (
	"testing"
	"time"

	"github.com/oaldesi/qa-portal/internal/model"
)

// Calls and sales come in one Vonage sheet; each task type takes its rows by
// Service name.
func TestSheetRowsTakesItsRows(t *testing.T) {
	s := &Sheet{Headers: []string{"Interaction ID", "Agent", "Service name"}, Rows: []map[string]string{
		{"Interaction ID": "1", "Agent": "A", "Service name": "New Sales"},
		{"Interaction ID": "2", "Agent": "B", "Service name": "Other Sales"},
		{"Interaction ID": "3", "Agent": "C", "Service name": " new sales "},
	}}
	sales := model.Columns{ExternalID: "Interaction ID", AgentName: "Agent", RowColumn: "Service name", RowValues: []string{"New Sales"}}
	rows, err := SheetRows(s, sales, time.UTC)
	if err != nil || len(rows) != 2 || rows[0].ExternalID != "1" || rows[1].ExternalID != "3" {
		t.Fatalf("sales rows = %+v, %v; want 1 and 3", rows, err)
	}
	all := sales
	all.RowColumn = ""
	if rows, _ := SheetRows(s, all, time.UTC); len(rows) != 3 {
		t.Errorf("no row column takes every row, got %d", len(rows))
	}
	sales.RowColumn = "Queue"
	if _, err := SheetRows(s, sales, time.UTC); err == nil {
		t.Error("a row column the sheet lacks should be refused")
	}
}
