package data

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/santifer/career-ops/dashboard/internal/model"
)

const tasksHeader = `# Tasks

Follow-up tasks generated from cadence rules, contacto suggestions, and manual entries. Managed by ` + "`sync-tasks.mjs`" + ` and the dashboard.

| # | Created | Due | App# | Company | Type | Title | Status | Completed | Notes |
|---|---------|-----|------|---------|------|-------|--------|-----------|-------|
`

const followupsHeader = `# Follow-up History

| # | App# | Date | Company | Role | Channel | Contact | Notes |
|---|------|------|---------|------|---------|---------|-------|
`

func tasksFilePath(careerOpsPath string) string {
	return filepath.Join(careerOpsPath, "data", "tasks.md")
}

func followupsFilePath(careerOpsPath string) string {
	return filepath.Join(careerOpsPath, "data", "follow-ups.md")
}

// ParseTasks reads data/tasks.md and returns parsed tasks. Returns an empty
// slice (not nil) if the file is missing so callers can render an empty view.
func ParseTasks(careerOpsPath string) []model.Task {
	content, err := os.ReadFile(tasksFilePath(careerOpsPath))
	if err != nil {
		return []model.Task{}
	}

	tasks := []model.Task{}
	for _, line := range strings.Split(string(content), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || !strings.HasPrefix(line, "|") {
			continue
		}
		if strings.HasPrefix(line, "|---") || strings.HasPrefix(line, "| #") {
			continue
		}
		line = strings.Trim(line, "|")
		raw := strings.Split(line, "|")
		fields := make([]string, 0, len(raw))
		for _, f := range raw {
			fields = append(fields, strings.TrimSpace(f))
		}
		if len(fields) < 9 {
			continue
		}

		num, err := strconv.Atoi(fields[0])
		if err != nil {
			continue
		}

		appNum := 0
		if fields[3] != "" && fields[3] != "-" {
			if n, err := strconv.Atoi(fields[3]); err == nil {
				appNum = n
			}
		}

		notes := ""
		if len(fields) > 9 {
			notes = fields[9]
		}

		tasks = append(tasks, model.Task{
			Number:    num,
			Created:   fields[1],
			Due:       fields[2],
			AppNumber: appNum,
			Company:   fields[4],
			Type:      fields[5],
			Title:     fields[6],
			Status:    strings.ToLower(fields[7]),
			Completed: fields[8],
			Notes:     notes,
		})
	}
	return tasks
}

// formatTaskRow renders a model.Task as a markdown table row matching the
// schema written by sync-tasks.mjs.
func formatTaskRow(t model.Task) string {
	appCol := "-"
	if t.AppNumber > 0 {
		appCol = fmt.Sprintf("%d", t.AppNumber)
	}
	company := t.Company
	if company == "" {
		company = "-"
	}
	due := t.Due
	if due == "" {
		due = "-"
	}
	completed := t.Completed
	if completed == "" {
		completed = "-"
	}
	return fmt.Sprintf("| %d | %s | %s | %s | %s | %s | %s | %s | %s | %s |",
		t.Number, t.Created, due, appCol, company, t.Type, t.Title, t.Status, completed, t.Notes)
}

// readTasksFile reads tasks.md and splits into header lines and existing data rows.
// If the file is missing, it returns just the canonical header with no rows.
func readTasksFile(careerOpsPath string) (headerLines []string, dataRows []string, err error) {
	content, err := os.ReadFile(tasksFilePath(careerOpsPath))
	if err != nil {
		if os.IsNotExist(err) {
			return strings.Split(strings.TrimRight(tasksHeader, "\n"), "\n"), nil, nil
		}
		return nil, nil, err
	}
	for _, line := range strings.Split(string(content), "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "|") &&
			!strings.HasPrefix(trimmed, "|---") &&
			!strings.HasPrefix(trimmed, "| #") {
			// Data row (must start with | <number>)
			parts := strings.Split(strings.Trim(trimmed, "|"), "|")
			if len(parts) >= 1 {
				if _, err := strconv.Atoi(strings.TrimSpace(parts[0])); err == nil {
					dataRows = append(dataRows, line)
					continue
				}
			}
		}
		headerLines = append(headerLines, line)
	}
	// Strip trailing blank lines from header so writes don't double-pad.
	for len(headerLines) > 0 && strings.TrimSpace(headerLines[len(headerLines)-1]) == "" {
		headerLines = headerLines[:len(headerLines)-1]
	}
	return headerLines, dataRows, nil
}

func writeTasksFile(careerOpsPath string, headerLines, dataRows []string) error {
	path := tasksFilePath(careerOpsPath)
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}
	var body strings.Builder
	for _, l := range headerLines {
		body.WriteString(l)
		body.WriteString("\n")
	}
	for _, r := range dataRows {
		body.WriteString(r)
		body.WriteString("\n")
	}
	return os.WriteFile(path, []byte(body.String()), 0644)
}

// UpdateTaskStatus rewrites the matching task row with a new status and completion
// date. completed may be empty (will be normalized to "-").
func UpdateTaskStatus(careerOpsPath string, taskNumber int, newStatus, completed string) (model.Task, error) {
	header, rows, err := readTasksFile(careerOpsPath)
	if err != nil {
		return model.Task{}, err
	}
	var updated model.Task
	found := false
	for i, row := range rows {
		parts := strings.Split(strings.Trim(strings.TrimSpace(row), "|"), "|")
		if len(parts) < 9 {
			continue
		}
		num, err := strconv.Atoi(strings.TrimSpace(parts[0]))
		if err != nil || num != taskNumber {
			continue
		}
		t := parseRowParts(parts)
		t.Status = strings.ToLower(newStatus)
		if completed == "" {
			t.Completed = "-"
		} else {
			t.Completed = completed
		}
		rows[i] = formatTaskRow(t)
		updated = t
		found = true
		break
	}
	if !found {
		return model.Task{}, fmt.Errorf("task #%d not found", taskNumber)
	}
	if err := writeTasksFile(careerOpsPath, header, rows); err != nil {
		return model.Task{}, err
	}
	return updated, nil
}

// AppendTask appends a new task row, assigning it the next sequential number
// and a created date of today if not already set. Returns the persisted task.
func AppendTask(careerOpsPath string, t model.Task) (model.Task, error) {
	header, rows, err := readTasksFile(careerOpsPath)
	if err != nil {
		return model.Task{}, err
	}
	maxNum := 0
	for _, row := range rows {
		parts := strings.Split(strings.Trim(strings.TrimSpace(row), "|"), "|")
		if len(parts) < 1 {
			continue
		}
		if n, err := strconv.Atoi(strings.TrimSpace(parts[0])); err == nil && n > maxNum {
			maxNum = n
		}
	}
	t.Number = maxNum + 1
	if t.Created == "" {
		t.Created = time.Now().Format("2006-01-02")
	}
	if t.Status == "" {
		t.Status = "pending"
	}
	if t.Completed == "" {
		t.Completed = "-"
	}
	if t.Due == "" {
		t.Due = "-"
	}
	rows = append(rows, formatTaskRow(t))
	if err := writeTasksFile(careerOpsPath, header, rows); err != nil {
		return model.Task{}, err
	}
	return t, nil
}

// parseRowParts extracts a Task from already split-by-pipe parts. The caller
// must have at least 9 trimmed parts.
func parseRowParts(parts []string) model.Task {
	for i := range parts {
		parts[i] = strings.TrimSpace(parts[i])
	}
	num, _ := strconv.Atoi(parts[0])
	appNum := 0
	if parts[3] != "" && parts[3] != "-" {
		if n, err := strconv.Atoi(parts[3]); err == nil {
			appNum = n
		}
	}
	notes := ""
	if len(parts) > 9 {
		notes = parts[9]
	}
	return model.Task{
		Number:    num,
		Created:   parts[1],
		Due:       parts[2],
		AppNumber: appNum,
		Company:   parts[4],
		Type:      parts[5],
		Title:     parts[6],
		Status:    strings.ToLower(parts[7]),
		Completed: parts[8],
		Notes:     notes,
	}
}

// AppendFollowupHistory appends a row to data/follow-ups.md so the cadence
// script counts the follow-up and advances the cycle on next sync. Creates the
// file with a canonical header if missing.
func AppendFollowupHistory(careerOpsPath string, appNum int, date, company, role, channel, contact, notes string) error {
	path := followupsFilePath(careerOpsPath)
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}
	content, err := os.ReadFile(path)
	var headerLines []string
	var rows []string
	if err != nil {
		if !os.IsNotExist(err) {
			return err
		}
		headerLines = strings.Split(strings.TrimRight(followupsHeader, "\n"), "\n")
	} else {
		for _, line := range strings.Split(string(content), "\n") {
			trimmed := strings.TrimSpace(line)
			if strings.HasPrefix(trimmed, "|") &&
				!strings.HasPrefix(trimmed, "|---") &&
				!strings.HasPrefix(trimmed, "| #") {
				parts := strings.Split(strings.Trim(trimmed, "|"), "|")
				if len(parts) >= 1 {
					if _, err := strconv.Atoi(strings.TrimSpace(parts[0])); err == nil {
						rows = append(rows, line)
						continue
					}
				}
			}
			headerLines = append(headerLines, line)
		}
		for len(headerLines) > 0 && strings.TrimSpace(headerLines[len(headerLines)-1]) == "" {
			headerLines = headerLines[:len(headerLines)-1]
		}
	}

	maxNum := 0
	for _, row := range rows {
		parts := strings.Split(strings.Trim(strings.TrimSpace(row), "|"), "|")
		if len(parts) < 1 {
			continue
		}
		if n, err := strconv.Atoi(strings.TrimSpace(parts[0])); err == nil && n > maxNum {
			maxNum = n
		}
	}
	next := maxNum + 1
	if channel == "" {
		channel = "Dashboard"
	}
	if contact == "" {
		contact = "-"
	}
	row := fmt.Sprintf("| %d | %d | %s | %s | %s | %s | %s | %s |",
		next, appNum, date, company, role, channel, contact, notes)
	rows = append(rows, row)

	var body strings.Builder
	for _, l := range headerLines {
		body.WriteString(l)
		body.WriteString("\n")
	}
	for _, r := range rows {
		body.WriteString(r)
		body.WriteString("\n")
	}
	return os.WriteFile(path, []byte(body.String()), 0644)
}
