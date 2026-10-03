package data

import (
	"os"
	"path/filepath"
	"testing"
)

// writeTasksFixture creates data/tasks.md under a temp careerOpsPath and
// returns the path. Columns: # | Created | Due | App# | Company | Type |
// Title | Status | Completed | Notes
func writeTasksFixture(t *testing.T, body string) string {
	t.Helper()
	tempDir := t.TempDir()
	dataDir := filepath.Join(tempDir, "data")
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		t.Fatalf("failed to create data dir: %v", err)
	}
	content := `# Tasks

| # | Created | Due | App# | Company | Type | Title | Status | Completed | Notes |
|---|---------|-----|------|---------|------|-------|--------|-----------|-------|
` + body
	if err := os.WriteFile(filepath.Join(dataDir, "tasks.md"), []byte(content), 0o644); err != nil {
		t.Fatalf("failed to write tasks fixture: %v", err)
	}
	return tempDir
}

func TestCompletePendingTasksForApp(t *testing.T) {
	// App 50 has two pending tasks (1, 3) and one already done (2).
	// App 77 has a pending task (4) that must be left untouched.
	tempDir := writeTasksFixture(t, `| 1 | 2026-05-01 | 2026-05-08 | 50 | Acme | followup | Ping recruiter | pending | - | - |
| 2 | 2026-05-01 | 2026-05-02 | 50 | Acme | followup | Thank-you note | done | 2026-05-03 | - |
| 3 | 2026-05-04 | 2026-05-10 | 50 | Acme | followup | Second nudge | pending | - | - |
| 4 | 2026-05-04 | 2026-05-10 | 77 | Globex | followup | Ping recruiter | pending | - | - |
`)

	n, err := CompletePendingTasksForApp(tempDir, 50, "2026-06-01")
	if err != nil {
		t.Fatalf("CompletePendingTasksForApp returned error: %v", err)
	}
	if n != 2 {
		t.Fatalf("expected 2 tasks completed, got %d", n)
	}

	tasks := ParseTasks(tempDir)
	byNum := map[int]struct {
		status    string
		completed string
	}{}
	for _, task := range tasks {
		byNum[task.Number] = struct {
			status    string
			completed string
		}{task.Status, task.Completed}
	}

	// App 50's pending tasks flipped to done with the supplied date.
	for _, num := range []int{1, 3} {
		if byNum[num].status != "done" {
			t.Errorf("task #%d: expected status done, got %q", num, byNum[num].status)
		}
		if byNum[num].completed != "2026-06-01" {
			t.Errorf("task #%d: expected completed 2026-06-01, got %q", num, byNum[num].completed)
		}
	}
	// Already-done task keeps its original completion date.
	if byNum[2].completed != "2026-05-03" {
		t.Errorf("task #2: expected original completed date preserved, got %q", byNum[2].completed)
	}
	// Other app's pending task is untouched.
	if byNum[4].status != "pending" {
		t.Errorf("task #4 (other app): expected status pending, got %q", byNum[4].status)
	}
}

func TestCompletePendingTasksForAppNoMatchDoesNotError(t *testing.T) {
	tempDir := writeTasksFixture(t, `| 1 | 2026-05-01 | 2026-05-08 | 50 | Acme | followup | Ping recruiter | pending | - | - |
`)
	// App 999 has no tasks: zero updates, no error, no write needed.
	n, err := CompletePendingTasksForApp(tempDir, 999, "2026-06-01")
	if err != nil {
		t.Fatalf("expected no error for no-match app, got %v", err)
	}
	if n != 0 {
		t.Fatalf("expected 0 tasks completed, got %d", n)
	}
}
