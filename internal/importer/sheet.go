package importer

import (
	"bytes"
	"encoding/csv"
	"errors"
	"fmt"
	"io"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/xuri/excelize/v2"

	"github.com/oaldesi/qa-portal/internal/model"
)

// Sheet is a parsed upload: headers in file order, and one map per data row.
type Sheet struct {
	Headers []string
	Rows    []map[string]string
}

// ParseSheet reads an .xlsx or a .csv. In a workbook with several tabs it
// takes the first tab whose header row has every column in need (the HR
// workbook keeps its roster on the second tab), else the first tab. The first
// non-empty row is the header; columns with a blank header (Vonage's leading
// row-number column) are dropped.
func ParseSheet(filename string, r io.Reader, need ...string) (*Sheet, error) {
	switch strings.ToLower(filepath.Ext(filename)) {
	case ".xlsx", ".xlsm":
		f, err := excelize.OpenReader(r)
		if err != nil {
			return nil, fmt.Errorf("could not open the workbook: %w", err)
		}
		defer f.Close()
		var first *Sheet
		for _, name := range f.GetSheetList() {
			grid, err := f.GetRows(name)
			if err != nil {
				return nil, fmt.Errorf("could not read tab %q: %w", name, err)
			}
			s := gridSheet(grid)
			if s.hasAll(need) {
				return s, nil
			}
			if first == nil {
				first = s
			}
		}
		if first == nil || len(first.Headers) == 0 {
			return nil, errors.New("the workbook is empty")
		}
		return first, nil
	case ".csv":
		raw, err := io.ReadAll(r)
		if err != nil {
			return nil, err
		}
		cr := csv.NewReader(bytes.NewReader(bytes.TrimPrefix(raw, []byte("\xef\xbb\xbf"))))
		cr.FieldsPerRecord = -1
		grid, err := cr.ReadAll()
		if err != nil {
			return nil, fmt.Errorf("could not read the csv: %w", err)
		}
		if s := gridSheet(grid); len(s.Headers) > 0 {
			return s, nil
		}
		return nil, errors.New("the sheet is empty")
	}
	return nil, errors.New("upload an .xlsx or .csv file")
}

func gridSheet(grid [][]string) *Sheet {
	for len(grid) > 0 && blank(grid[0]) {
		grid = grid[1:]
	}
	s := &Sheet{}
	if len(grid) == 0 {
		return s
	}
	header := grid[0]
	for _, h := range header {
		if h = strings.TrimSpace(h); h != "" {
			s.Headers = append(s.Headers, h)
		}
	}
	for _, cells := range grid[1:] {
		if blank(cells) {
			continue
		}
		row := map[string]string{}
		for i, h := range header {
			if h = strings.TrimSpace(h); h != "" && i < len(cells) {
				row[h] = strings.TrimSpace(cells[i])
			}
		}
		s.Rows = append(s.Rows, row)
	}
	return s
}

func (s *Sheet) hasAll(headers []string) bool {
	for _, h := range headers {
		if !slices.ContainsFunc(s.Headers, func(x string) bool { return strings.EqualFold(x, h) }) {
			return false
		}
	}
	return true
}

// SheetRows maps a parsed sheet onto importer rows using the type's columns.
// clock is the zone the sheet's start times are written in (Vonage: UTC−5).
func SheetRows(s *Sheet, c model.Columns, clock *time.Location) ([]Row, error) {
	// The calls export identifies agents by Agent ID; the sales export only
	// by name, so then the name column is the one that must be there.
	agentCol := c.AgentCode
	if agentCol == "" {
		agentCol = c.AgentName
	}
	need := []string{c.ExternalID, agentCol}
	if c.RowColumn != "" {
		need = append(need, c.RowColumn)
	}
	for _, h := range need {
		if !s.has(h) {
			return nil, fmt.Errorf("column %q not found; the sheet has: %s", h, strings.Join(s.Headers, ", "))
		}
	}
	rows := make([]Row, 0, len(s.Rows))
	for _, sr := range s.Rows {
		if !c.Takes(sr) {
			continue // another task type's row of a shared sheet
		}
		ext := sr[c.ExternalID]
		if ext == "" {
			continue // a totals line or a stray cell, not a call
		}
		data := make(map[string]any, len(sr))
		for k, v := range sr {
			data[k] = v
		}
		var labels []string
		if l := sr[c.Label]; c.Label != "" && l != "" {
			labels = []string{l}
		}
		var key string // empty when the sheet carries names only
		if c.AgentCode != "" {
			key = sr[c.AgentCode]
		}
		row := Row{ExternalID: ext, AgentKey: key, AgentName: sr[c.AgentName], Labels: labels, Data: data}
		if c.StartTime != "" {
			row.StartedAt = ParseCallTime(sr[c.StartTime], clock)
		}
		rows = append(rows, row)
	}
	return rows, nil
}

// SheetDays counts a sheet's rows by the day they started, as the sheet
// writes it (in its own clock). Rows without a readable start are left out.
func SheetDays(s *Sheet, col string, clock *time.Location) map[string]int {
	days := map[string]int{}
	if col == "" {
		return days
	}
	for _, row := range s.Rows {
		if t := ParseCallTime(row[col], clock); t != nil {
			days[t.In(clock).Format(time.DateOnly)]++
		}
	}
	return days
}

func (s *Sheet) has(h string) bool {
	for _, x := range s.Headers {
		if x == h {
			return true
		}
	}
	return false
}

func blank(cells []string) bool {
	for _, c := range cells {
		if strings.TrimSpace(c) != "" {
			return false
		}
	}
	return true
}
