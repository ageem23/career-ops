package main

import (
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/santifer/career-ops/dashboard/internal/data"
	"github.com/santifer/career-ops/dashboard/internal/model"
	"github.com/santifer/career-ops/dashboard/internal/theme"
	"github.com/santifer/career-ops/dashboard/internal/ui/screens"
)

// findCareerOpsRoot walks up from start looking for a directory that contains
// applications.md or data/applications.md, so `go run .` works from anywhere
// inside the project (e.g. the dashboard/ subdir). Returns start unchanged if
// no marker is reached before the filesystem root or if a non-NotExist stat
// error is encountered.
func findCareerOpsRoot(start string) string {
	abs, err := filepath.Abs(start)
	if err != nil {
		return start
	}
	markers := []string{"applications.md", filepath.Join("data", "applications.md")}
	cur := abs
	for {
		for _, marker := range markers {
			statPath := filepath.Join(cur, marker)
			if _, statErr := os.Stat(statPath); statErr == nil {
				return cur
			} else if !os.IsNotExist(statErr) {
				// Permission-denied or I/O error — surface it instead of
				// silently treating it as "marker not found" and continuing.
				fmt.Fprintf(os.Stderr, "warning: stat %s: %v\n", statPath, statErr)
				return start
			}
		}
		parent := filepath.Dir(cur)
		if parent == cur {
			// Reached filesystem root without finding a marker.
			return start
		}
		cur = parent
	}
}

type viewState int

const (
	viewPipeline viewState = iota
	viewReport
	viewProgress
	viewTasks
)

// tasksSyncedMsg signals that an asynchronous runSyncTasks invocation finished.
type tasksSyncedMsg struct{}

type appModel struct {
	pipeline        screens.PipelineModel
	viewer          screens.ViewerModel
	progress        screens.ProgressModel
	tasks           screens.TasksModel
	state           viewState
	viewerSource    viewState // which screen opened the report viewer
	careerOpsPath   string
	theme           theme.Theme
	progressMetrics model.ProgressMetrics
}

func (m *appModel) reloadPipelineData() {
	apps := data.ParseApplications(m.careerOpsPath)
	metrics := data.ComputeMetrics(apps)
	m.progressMetrics = data.ComputeProgressMetrics(apps)
	m.pipeline = m.pipeline.WithReloadedData(apps, metrics)
}

func (m appModel) Init() tea.Cmd {
	return nil
}

func (m appModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.pipeline.Resize(msg.Width, msg.Height)
		if m.state == viewReport {
			m.viewer.Resize(msg.Width, msg.Height)
		}
		if m.state == viewProgress {
			m.progress.Resize(msg.Width, msg.Height)
		}
		if m.state == viewTasks {
			m.tasks.Resize(msg.Width, msg.Height)
		}
		pm, cmd := m.pipeline.Update(msg)
		m.pipeline = pm
		return m, cmd

	case screens.PipelineClosedMsg:
		return m, tea.Quit

	case screens.PipelineLoadReportMsg:
		archetype, tldr, remote, comp := data.LoadReportSummary(msg.CareerOpsPath, msg.ReportPath)
		m.pipeline.EnrichReport(msg.ReportPath, archetype, tldr, remote, comp)
		return m, nil

	case screens.PipelineUpdateStatusMsg:
		applyStatusUpdate(msg.CareerOpsPath, msg.App, msg.NewStatus)
		m.reloadPipelineData()
		return m, nil

	case screens.PipelineBulkUpdateStatusMsg:
		// Same code path per app as the single-row update so the
		// Interview thank-you cascade fires for each row in the
		// selection, and errors on individual rows don't abort the rest.
		for _, app := range msg.Apps {
			applyStatusUpdate(msg.CareerOpsPath, app, msg.NewStatus)
		}
		m.reloadPipelineData()
		return m, nil

	case screens.PipelineRefreshMsg:
		m.reloadPipelineData()
		return m, nil

	case screens.PipelineOpenReportMsg:
		m.viewer = screens.NewViewerModel(
			m.theme,
			msg.Path, msg.Title,
			m.pipeline.Width(), m.pipeline.Height(),
			msg.App, msg.CareerOpsPath,
			tasksForApp(m.careerOpsPath, msg.App.Number),
		)
		m.viewerSource = viewPipeline
		m.state = viewReport
		return m, nil

	case screens.ViewerClosedMsg:
		m.state = m.viewerSource
		return m, nil

	case screens.ViewerOpenTasksMsg:
		tasks := data.ParseTasks(m.careerOpsPath)
		w, h := m.pipeline.Width(), m.pipeline.Height()
		m.tasks = screens.NewTasksModel(m.theme, tasks, w, h)
		m.tasks.FocusOnApp(msg.AppNumber)
		if m.tasks.HasCurrent() {
			m.tasks.SetFlash(fmt.Sprintf("Showing tasks for app #%d.", msg.AppNumber))
		} else {
			m.tasks.SetFlash(fmt.Sprintf("No tasks linked to app #%d yet.", msg.AppNumber))
		}
		m.state = viewTasks
		return m, nil

	case screens.PipelineOpenProgressMsg:
		m.progress = screens.NewProgressModel(
			theme.NewTheme("catppuccin-mocha"),
			m.progressMetrics,
			m.pipeline.Width(), m.pipeline.Height(),
		)
		m.state = viewProgress
		return m, nil

	case screens.ProgressClosedMsg:
		m.state = viewPipeline
		return m, nil

	case screens.PipelineOpenTasksMsg:
		tasks := data.ParseTasks(m.careerOpsPath)
		m.tasks = screens.NewTasksModel(m.theme, tasks, m.pipeline.Width(), m.pipeline.Height())
		m.state = viewTasks
		return m, nil

	case screens.TasksClosedMsg:
		m.state = viewPipeline
		return m, nil

	case screens.TasksMarkStatusMsg:
		m.handleTaskMarkStatus(msg)
		return m, nil

	case screens.PipelineAddTaskMsg:
		m.handlePipelineAddTask(msg)
		return m, nil

	case screens.TasksRefreshMsg:
		// Bubble Tea Update must stay non-blocking — sync-tasks shells out to
		// node and can take seconds. Run it in a tea.Cmd goroutine and
		// reload when the subprocess returns.
		path := m.careerOpsPath
		m.tasks.SetFlash("Syncing…")
		return m, func() tea.Msg {
			runSyncTasks(path)
			return tasksSyncedMsg{}
		}

	case tasksSyncedMsg:
		tasks := data.ParseTasks(m.careerOpsPath)
		m.tasks = m.tasks.WithReloadedTasks(tasks)
		m.tasks.SetFlash("Tasks synced.")
		return m, nil

	case screens.TasksOpenReportMsg:
		apps := data.ParseApplications(m.careerOpsPath)
		app, ok := data.FindApplicationByNumber(apps, msg.AppNumber)
		if !ok || app.ReportPath == "" {
			m.tasks.SetFlash(fmt.Sprintf("No report linked for app #%d.", msg.AppNumber))
			return m, nil
		}
		fullPath := filepath.Join(m.careerOpsPath, app.ReportPath)
		title := fmt.Sprintf("%s — %s", app.Company, app.Role)
		m.viewer = screens.NewViewerModel(
			m.theme,
			fullPath, title,
			m.tasks.Width(), m.tasks.Height(),
			app, m.careerOpsPath,
			tasksForApp(m.careerOpsPath, app.Number),
		)
		m.viewerSource = viewTasks
		m.state = viewReport
		return m, nil

	case screens.PipelineOpenURLMsg:
		url := msg.URL
		return m, func() tea.Msg {
			var cmd *exec.Cmd
			switch runtime.GOOS {
			case "darwin":
				cmd = exec.Command("open", url)
			case "linux":
				cmd = exec.Command("xdg-open", url)
			case "windows":
				cmd = exec.Command("cmd", "/c", "start", "", url)
			default:
				cmd = exec.Command("xdg-open", url)
			}
			_ = cmd.Run()
			return nil
		}

	default:
		if m.state == viewReport {
			vm, cmd := m.viewer.Update(msg)
			m.viewer = vm
			return m, cmd
		}
		if m.state == viewProgress {
			pg, cmd := m.progress.Update(msg)
			m.progress = pg
			return m, cmd
		}
		if m.state == viewTasks {
			tm, cmd := m.tasks.Update(msg)
			m.tasks = tm
			return m, cmd
		}
		pm, cmd := m.pipeline.Update(msg)
		m.pipeline = pm
		return m, cmd
	}
}

// handleTaskMarkStatus writes a status change for a task and cascades the
// follow-ups.md / applications.md updates that keep the cadence honest.
//
// The cascade (tasks.md → follow-ups.md → applications.md Notes) is best-effort:
// each step logs to stderr on failure and the rest continue. Partial state is
// recoverable — the next sync-tasks run reconciles cadence counts against
// follow-ups.md, and the Notes column is purely informational.
func (m *appModel) handleTaskMarkStatus(msg screens.TasksMarkStatusMsg) {
	today := time.Now().Format("2006-01-02")
	// Reopen clears Completed (passing "" tells UpdateTaskStatus to normalize
	// to "-"). Done/skipped stamp today's date.
	completed := today
	if msg.NewStatus == "pending" {
		completed = ""
	}
	updated, err := data.UpdateTaskStatus(m.careerOpsPath, msg.Task.Number, msg.NewStatus, completed)
	if err != nil {
		fmt.Fprintf(os.Stderr, "WARN: task update failed: %v\n", err)
		return
	}

	// Reopen cascade: when a followup task is moved back to pending, also
	// remove the matching row from follow-ups.md so the cadence count stays
	// accurate. The previous "Follow-up N sent" note in applications.md is
	// left in place — purely informational, costly to surgically remove.
	if msg.NewStatus == "pending" && msg.Task.Status == "done" && updated.Type == "followup" && updated.AppNumber > 0 {
		if _, err := data.RemoveFollowupHistory(m.careerOpsPath, updated.AppNumber, updated.Title); err != nil {
			fmt.Fprintf(os.Stderr, "WARN: follow-up history remove failed: %v\n", err)
		}
	}

	if msg.NewStatus == "done" && updated.Type == "followup" && updated.AppNumber > 0 {
		apps := data.ParseApplications(m.careerOpsPath)
		app, ok := data.FindApplicationByNumber(apps, updated.AppNumber)
		if !ok {
			// Without the application row we can't write a meaningful Notes
			// entry, and writing only the follow-up history would leave the
			// two files permanently out of sync. Skip the whole cascade.
			fmt.Fprintf(os.Stderr, "WARN: app #%d not found; skipping follow-up cascade\n", updated.AppNumber)
		} else {
			if err := data.AppendFollowupHistory(
				m.careerOpsPath,
				updated.AppNumber, today, updated.Company, app.Role,
				"Dashboard", "-", updated.Title,
			); err != nil {
				fmt.Fprintf(os.Stderr, "WARN: follow-up history append failed: %v\n", err)
			}
			cycle := cycleFromTitle(updated.Title)
			note := fmt.Sprintf("Follow-up %s sent %s", cycle, today)
			if err := data.AppendApplicationNote(m.careerOpsPath, app.ReportNumber, note); err != nil {
				fmt.Fprintf(os.Stderr, "WARN: application note append failed: %v\n", err)
			}
			m.reloadPipelineData()
		}
	}

	tasks := data.ParseTasks(m.careerOpsPath)
	m.tasks = m.tasks.WithReloadedTasks(tasks)
	verb := map[string]string{
		"done":    "completed",
		"skipped": "skipped",
		"pending": "reopened",
	}[msg.NewStatus]
	if verb == "" {
		verb = "updated"
	}
	m.tasks.SetFlash(fmt.Sprintf("Task #%d %s.", updated.Number, verb))
}

// handlePipelineAddTask creates a manual task linked to the application
// selected in the pipeline view. The task's Company is populated from the
// app row so the task and the application stay in sync without the user
// having to type the company name twice.
func (m *appModel) handlePipelineAddTask(msg screens.PipelineAddTaskMsg) {
	t := model.Task{
		Type:      "manual",
		Title:     msg.Title,
		Status:    "pending",
		Created:   time.Now().Format("2006-01-02"),
		Due:       msg.Due,
		AppNumber: msg.App.Number,
		Company:   msg.App.Company,
	}
	created, err := data.AppendTask(m.careerOpsPath, t)
	if err != nil {
		fmt.Fprintf(os.Stderr, "WARN: task add failed: %v\n", err)
		return
	}
	target := msg.App.Company
	if msg.App.Number > 0 {
		target = fmt.Sprintf("#%d %s", msg.App.Number, msg.App.Company)
	}
	// Reload tasks so a later Esc-then-t to the tasks view shows the new row.
	tasks := data.ParseTasks(m.careerOpsPath)
	m.tasks = m.tasks.WithReloadedTasks(tasks)
	flash := fmt.Sprintf("Added task #%d for %s.", created.Number, target)
	m.tasks.SetFlash(flash)
	fmt.Fprintln(os.Stderr, flash)
}

// tasksForApp returns the subset of tasks whose AppNumber matches the given
// application number, in their on-disk order. Used to render the tasks panel
// at the top of the report viewer.
func tasksForApp(careerOpsPath string, appNumber int) []model.Task {
	if appNumber <= 0 {
		return nil
	}
	all := data.ParseTasks(careerOpsPath)
	out := make([]model.Task, 0, 4)
	for _, t := range all {
		if t.AppNumber == appNumber {
			out = append(out, t)
		}
	}
	return out
}

// runSyncTasks shells out to sync-tasks.mjs. Best-effort: missing node, missing
// script, or a non-zero exit all log to stderr and return without blocking.
func runSyncTasks(careerOpsPath string) {
	syncScript := filepath.Join(careerOpsPath, "sync-tasks.mjs")
	if _, err := os.Stat(syncScript); err != nil {
		if !os.IsNotExist(err) {
			fmt.Fprintf(os.Stderr, "warning: stat %s: %v\n", syncScript, err)
		}
		return
	}
	if _, err := exec.LookPath("node"); err != nil {
		fmt.Fprintf(os.Stderr, "warning: node not found in PATH; task sync disabled\n")
		return
	}
	cmd := exec.Command("node", syncScript)
	cmd.Dir = careerOpsPath
	if out, err := cmd.CombinedOutput(); err != nil {
		fmt.Fprintf(os.Stderr, "warning: sync-tasks failed: %v\n%s\n", err, string(out))
	}
}

// applyStatusUpdate writes a status change for one application and fires any
// per-app cascade side effects (auto-create an Interview thank-you task on
// Interview, auto-complete pending tasks on Rejected/Discarded). Used by both
// the single-row and bulk status handlers so the two paths stay byte-for-byte
// consistent on behavior.
func applyStatusUpdate(careerOpsPath string, app model.CareerApplication, newStatus string) {
	if err := data.UpdateApplicationStatus(careerOpsPath, app, newStatus); err != nil {
		// Bail out before firing the cascade. The status write is what makes
		// the transition real; without it, auto-creating an Interview
		// thank-you task would leave a "send thank-you" task pointing at an
		// app whose tracker status never actually changed.
		fmt.Fprintf(os.Stderr, "WARN: status update failed for #%d: %v\n", app.Number, err)
		return
	}
	if app.Number <= 0 {
		return
	}
	switch data.NormalizeStatus(newStatus) {
	case "interview":
		autoCreateInterviewThankYou(careerOpsPath, app)
	case "rejected", "discarded":
		autoCompletePendingTasksForApp(careerOpsPath, app, newStatus)
	}
}

// autoCompletePendingTasksForApp marks every pending task for the application
// as done with today's completion date. Fired when the app transitions to a
// terminal status (Rejected / Discarded) so stale follow-up reminders stop
// surfacing in the dashboard for an app the user has already closed out.
func autoCompletePendingTasksForApp(careerOpsPath string, app model.CareerApplication, newStatus string) {
	today := time.Now().Format("2006-01-02")
	completed, err := data.CompletePendingTasksForApp(careerOpsPath, app.Number, today)
	if err != nil {
		fmt.Fprintf(os.Stderr, "WARN: auto-complete tasks for #%d failed: %v\n", app.Number, err)
		return
	}
	if completed > 0 {
		fmt.Fprintf(os.Stderr, "auto-completed %d pending task(s) for #%d %s on %s transition\n",
			completed, app.Number, app.Company, newStatus)
	}
}

// autoCreateInterviewThankYou appends a thank-you task on Interview transition,
// if one isn't already pending for the same app.
func autoCreateInterviewThankYou(careerOpsPath string, app model.CareerApplication) {
	if app.Number <= 0 {
		return
	}
	existing := data.ParseTasks(careerOpsPath)
	for _, t := range existing {
		if t.Status == "pending" && t.Type == "interview" && t.AppNumber == app.Number {
			return
		}
	}
	due := time.Now().Add(24 * time.Hour).Format("2006-01-02")
	t := model.Task{
		Type:      "interview",
		Title:     "Send thank-you note",
		Status:    "pending",
		Created:   time.Now().Format("2006-01-02"),
		Due:       due,
		AppNumber: app.Number,
		Company:   app.Company,
	}
	if _, err := data.AppendTask(careerOpsPath, t); err != nil {
		fmt.Fprintf(os.Stderr, "WARN: interview task add failed: %v\n", err)
	}
}

// cycleFromTitle extracts the cycle marker from a generated follow-up title,
// e.g. "Follow up #2 — ..." → "2". Returns "1" when no marker is found.
// ASCII-digit only by design: the marker is emitted verbatim by sync-tasks.mjs
// in the format "Follow up #<n> — …", so localized digits would mean the title
// generator and parser are out of sync — not a localization gap here.
func cycleFromTitle(title string) string {
	const prefix = "Follow up #"
	idx := strings.Index(title, prefix)
	if idx < 0 {
		return "1"
	}
	rest := title[idx+len(prefix):]
	end := 0
	for end < len(rest) && rest[end] >= '0' && rest[end] <= '9' {
		end++
	}
	if end == 0 {
		return "1"
	}
	return rest[:end]
}

func (m appModel) View() string {
	switch m.state {
	case viewReport:
		return m.viewer.View()
	case viewProgress:
		return m.progress.View()
	case viewTasks:
		return m.tasks.View()
	default:
		return m.pipeline.View()
	}
}

func main() {
	pathFlag := flag.String("path", ".", "Path to career-ops directory")
	flag.Parse()

	careerOpsPath := *pathFlag
	if *pathFlag == "." {
		careerOpsPath = findCareerOpsRoot(".")
	}

	// Reconcile cadence -> tasks before loading the UI. Best-effort: a failure
	// here (node missing, script error) should not block the dashboard.
	runSyncTasks(careerOpsPath)

	// Load applications
	apps := data.ParseApplications(careerOpsPath)
	if apps == nil {
		fmt.Fprintf(os.Stderr, "Error: could not find applications.md in %s or %s/data/\n", careerOpsPath, careerOpsPath)
		os.Exit(1)
	}

	// Compute metrics
	metrics := data.ComputeMetrics(apps)
	progressMetrics := data.ComputeProgressMetrics(apps)

	// Batch-load all report summaries
	t := theme.NewTheme("auto")
	pm := screens.NewPipelineModel(t, apps, metrics, careerOpsPath, 120, 40)

	for _, app := range apps {
		if app.ReportPath == "" {
			continue
		}
		archetype, tldr, remote, comp := data.LoadReportSummary(careerOpsPath, app.ReportPath)
		if archetype != "" || tldr != "" || remote != "" || comp != "" {
			pm.EnrichReport(app.ReportPath, archetype, tldr, remote, comp)
		}
	}

	m := appModel{
		pipeline:        pm,
		careerOpsPath:   careerOpsPath,
		theme:           t,
		progressMetrics: progressMetrics,
	}

	p := tea.NewProgram(m, tea.WithAltScreen())
	if _, err := p.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
}
