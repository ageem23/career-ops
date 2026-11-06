package main

import (
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/santifer/career-ops/dashboard/internal/data"
	"github.com/santifer/career-ops/dashboard/internal/i18n"
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
	viewStats
)

// tasksSyncedMsg signals that an asynchronous runSyncTasks invocation finished.
type tasksSyncedMsg struct{}

type appModel struct {
	pipeline        screens.PipelineModel
	viewer          screens.ViewerModel
	progress        screens.ProgressModel
	tasks           screens.TasksModel
	stats           screens.StatsModel
	state           viewState
	viewerSource    viewState // which screen opened the report viewer
	careerOpsPath   string
	theme           theme.Theme
	progressMetrics model.ProgressMetrics
	statsMetrics    model.StatsMetrics
	evaluatedCount  int
}

func (m *appModel) reloadPipelineData() {
	apps, trackerErr := data.ParseApplications(m.careerOpsPath)
	if trackerErr != nil {
		// Retain every derived value and surface the failure, the same way the
		// status-ledger read below does. Rebuilding from a failed read would
		// empty the pipeline AND drop every rate to 0% through
		// ComputeProgressMetrics, so the screen would report an empty, failing
		// search because a file could not be opened.
		m.pipeline, _ = m.pipeline.Update(screens.PipelineTrackerFailedMsg{Err: trackerErr.Error()})
		return
	}
	metrics := data.ComputeMetrics(apps)
	ledger, historyErr := data.ReadStatusLedger(m.careerOpsPath)
	if historyErr == nil {
		m.progressMetrics = data.ComputeProgressMetrics(apps, ledger.Reached)
	}
	// After a failed ledger read LatestDate is nil, so the DATE column falls
	// back to each row's tracker date while current statuses still refresh.
	data.ApplyStatusDates(apps, ledger.LatestDate)
	m.pipeline = m.pipeline.WithReloadedData(apps, metrics)
	enrichArchetypes(m.careerOpsPath, apps, &m.pipeline)
	m.statsMetrics = data.ComputeStatsMetrics(apps)
	// Count only apps with a score so the header reflects evaluated offers.
	m.evaluatedCount = 0
	for _, a := range apps {
		if a.Score > 0 {
			m.evaluatedCount++
		}
	}
	if historyErr != nil {
		// Refresh current statuses, but retain historical metrics and surface
		// the failed history read in the TUI after rebuilding the pipeline.
		m.pipeline, _ = m.pipeline.Update(screens.PipelineHistoryFailedMsg{Err: historyErr.Error()})
	}
}

// enrichArchetypes lazy-loads each app's report-derived archetype (used by
// the stats screen's breakdown table) and, as a side effect, primes the
// pipeline model's report preview cache the same way main()'s startup loop
// does — so a manual refresh doesn't blank out report previews.
func enrichArchetypes(careerOpsPath string, apps []model.CareerApplication, pm *screens.PipelineModel) {
	for i := range apps {
		if apps[i].ReportPath == "" {
			continue
		}
		archetype, tldr, remote, comp := data.LoadReportSummary(careerOpsPath, apps[i].ReportPath)
		// Only overwrite when the report actually supplies a non-empty archetype;
		// preserve any value already derived from the tracker.
		if archetype != "" {
			apps[i].Archetype = archetype
		}
		if archetype != "" || tldr != "" || remote != "" || comp != "" {
			pm.EnrichReport(apps[i].ReportPath, archetype, tldr, remote, comp)
		}
	}
}

func (m appModel) Init() tea.Cmd {
	return nil
}

// Update manages global app state and routes incoming messages to active screens.
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
		if m.state == viewStats {
			m.stats.Resize(msg.Width, msg.Height)
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
		err := applyStatusUpdate(msg.CareerOpsPath, msg.App, msg.NewStatus)
		m.reloadPipelineData()
		if err != nil {
			m.pipeline, _ = m.pipeline.Update(screens.StatusUpdateFailedMsg{Err: err.Error()})
		} else if data.NormalizeStatus(msg.NewStatus) == "hired" {
			m.pipeline, _ = m.pipeline.StartHiredFlow(msg.App)
		}
		return m, nil

	case screens.PipelineBulkUpdateStatusMsg:
		// Same code path per app as the single-row update so the
		// Interview thank-you cascade fires for each row in the
		// selection, and errors on individual rows don't abort the rest.
		// The Hired flow is per-application, so a bulk move does not start it.
		var failed []string
		var firstErr error
		for _, app := range msg.Apps {
			if err := applyStatusUpdate(msg.CareerOpsPath, app, msg.NewStatus); err != nil {
				if firstErr == nil {
					firstErr = err
				}
				failed = append(failed, fmt.Sprintf("#%d", app.Number))
			}
		}
		m.reloadPipelineData()
		if firstErr != nil {
			m.pipeline, _ = m.pipeline.Update(screens.StatusUpdateFailedMsg{
				Err: fmt.Sprintf("%d of %d failed (%s): %v", len(failed), len(msg.Apps), strings.Join(failed, ", "), firstErr),
			})
		}
		return m, nil

	case screens.PipelineUpdateStatusAndNotesMsg:
		// Issue 1380: atomic status + notes write from the discard reason picker.
		err := data.UpdateApplicationStatusAndNotes(msg.CareerOpsPath, msg.App, msg.NewStatus, msg.NotesAppend)
		m.reloadPipelineData()
		if err != nil {
			m.pipeline, _ = m.pipeline.Update(screens.StatusUpdateFailedMsg{Err: err.Error()})
		}
		return m, nil

	case screens.PipelineRefreshMsg:
		m.reloadPipelineData()
		return m, nil

	case screens.PipelineOpenReportMsg:
		m.viewer = screens.NewViewerModel(
			m.theme,
			msg.CareerOpsPath, msg.Path, msg.Title,
			m.pipeline.Width(), m.pipeline.Height(),
			msg.App,
			tasksForApp(m.careerOpsPath, msg.App.Number)...,
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

	case screens.ViewerOpenCoverLetterMsg:
		path := msg.Path
		return m, func() tea.Msg {
			if err := openWithDefaultApp(path); err != nil {
				fmt.Fprintf(os.Stderr, "WARN: could not open cover letter: %v\n", err)
			}
			return nil
		}

	case screens.ViewerUpdateStatusMsg:
		normalized := data.NormalizeStatus(msg.NewStatus)
		if normalized == "discarded" || normalized == "skip" {
			m.state = viewPipeline
			// Reload BEFORE opening the picker: reloadPipelineData rebuilds the
			// model via NewPipelineModel and carries over only a whitelist of
			// fields, so starting the flow first would wipe discardPicker and
			// the status change would be silently lost — this path relies on
			// the picker to commit PipelineUpdateStatusAndNotesMsg.
			m.reloadPipelineData()
			m.pipeline, _ = m.pipeline.StartDiscardReasonFlow(msg.App, msg.NewStatus)
			return m, nil
		}

		err := data.UpdateApplicationStatus(m.careerOpsPath, msg.App, msg.NewStatus)
		m.reloadPipelineData()
		if err != nil {
			// A sidecar failure can follow a successful tracker write. Reflect
			// the persisted status, retaining the old one if it cannot be read
			// or the report identity is no longer unique.
			if msg.App.ReportNumber != "" {
				savedStatus, matches := "", 0
				// A failed re-read leaves matches at 0, so the displayed status
				// stays as it was — which is what the comment above promises.
				saved, _ := data.ParseApplications(m.careerOpsPath)
				for _, app := range saved {
					if app.ReportNumber == msg.App.ReportNumber {
						savedStatus = app.Status
						matches++
					}
				}
				if matches == 1 {
					m.viewer.UpdateAppStatus(savedStatus)
				}
			}
			m.viewer, _ = m.viewer.Update(screens.StatusUpdateFailedMsg{Err: err.Error()})
			return m, nil
		}
		m.viewer.UpdateAppStatus(msg.NewStatus)
		if normalized == "hired" {
			m.state = viewPipeline
			m.pipeline, _ = m.pipeline.StartHiredFlow(msg.App)
		}
		return m, nil

	case screens.PipelineOpenProgressMsg:
		m.progress = screens.NewProgressModel(
			m.theme,
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
		apps, trackerErr := data.ParseApplications(m.careerOpsPath)
		if trackerErr != nil {
			m.tasks.SetFlash(fmt.Sprintf("Could not read the tracker: %v", trackerErr))
			return m, nil
		}
		app, ok := data.FindApplicationByNumber(apps, msg.AppNumber)
		if !ok || app.ReportPath == "" {
			m.tasks.SetFlash(fmt.Sprintf("No report linked for app #%d.", msg.AppNumber))
			return m, nil
		}
		fullPath := filepath.Join(m.careerOpsPath, app.ReportPath)
		title := fmt.Sprintf("%s — %s", app.Company, app.Role)
		m.viewer = screens.NewViewerModel(
			m.theme,
			m.careerOpsPath, fullPath, title,
			m.tasks.Width(), m.tasks.Height(),
			app,
			tasksForApp(m.careerOpsPath, app.Number)...,
		)
		m.viewerSource = viewTasks
		m.state = viewReport
		return m, nil

	case screens.PipelineOpenStatsMsg:
		m.stats = screens.NewStatsModel(
			m.theme,
			m.statsMetrics,
			m.evaluatedCount,
			m.pipeline.Width(), m.pipeline.Height(),
		)
		m.state = viewStats
		return m, nil

	case screens.StatsClosedMsg:
		m.state = viewPipeline
		return m, nil

	case screens.PipelineOpenURLMsg:
		return m, openCmd(msg.URL)

	case screens.PipelineOpenPDFMsg:
		return m, openCmd(msg.Path)

	case screens.PipelineCopyPDFPathMsg:
		return m, copyPathCmd(msg.Path)

	case screens.PipelineClipboardResultMsg:
		// The copy runs asynchronously and the user may have left the pipeline
		// meanwhile; the flash belongs to the pipeline whatever screen is shown.
		pm, cmd := m.pipeline.Update(msg)
		m.pipeline = pm
		return m, cmd

	case screens.PipelineGeneratePDFMsg:
		return m, runGeneratePDF(msg)

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
		if m.state == viewStats {
			sm, cmd := m.stats.Update(msg)
			m.stats = sm
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
		apps, trackerErr := data.ParseApplications(m.careerOpsPath)
		app, ok := data.FindApplicationByNumber(apps, updated.AppNumber)
		if trackerErr != nil {
			fmt.Fprintf(os.Stderr, "WARN: could not read the tracker (%v); skipping follow-up cascade\n", trackerErr)
		} else if !ok {
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
// consistent on behavior. The status-write error is returned so the caller can
// surface it in the TUI; cascade failures stay best-effort and only log.
func applyStatusUpdate(careerOpsPath string, app model.CareerApplication, newStatus string) error {
	if err := data.UpdateApplicationStatus(careerOpsPath, app, newStatus); err != nil {
		// Bail out before firing the cascade. The status write is what makes
		// the transition real; without it, auto-creating an Interview
		// thank-you task would leave a "send thank-you" task pointing at an
		// app whose tracker status never actually changed.
		fmt.Fprintf(os.Stderr, "WARN: status update failed for #%d: %v\n", app.Number, err)
		return err
	}
	if app.Number <= 0 {
		return nil
	}
	switch data.NormalizeStatus(newStatus) {
	case "interview":
		autoCreateInterviewThankYou(careerOpsPath, app)
	case "rejected", "discarded":
		autoCompletePendingTasksForApp(careerOpsPath, app, newStatus)
	}
	return nil
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

// openCmd wraps openWithDefaultApp (OS-specific) as a tea.Cmd. Shared by the
// job-URL (`o`, pipeline and report viewer) and CV-PDF (`d`) actions.
func openCmd(target string) tea.Cmd {
	return func() tea.Msg {
		if err := openWithDefaultApp(target); err != nil {
			// Issue 3913: the dashboard runs with tea.WithAltScreen(), so a
			// message on stderr is never visible. Report the failure back to
			// the pipeline screen, which flashes it in the help bar.
			return screens.PipelineOpenFailedMsg{Target: target, Err: err.Error()}
		}
		return nil
	}
}

// runGeneratePDF runs the checkout's generate-pdf.mjs against the selected data root,
// opens the resulting PDF on success, and reports the outcome back to the
// pipeline screen as a PipelinePDFGeneratedMsg. Runs in a tea.Cmd goroutine,
// so the UI stays responsive while Chromium renders.
func runGeneratePDF(msg screens.PipelineGeneratePDFMsg) tea.Cmd {
	return func() tea.Msg {
		script, err := data.CheckoutScriptPath("generate-pdf.mjs")
		if err != nil {
			return screens.PipelinePDFGeneratedMsg{Err: err.Error()}
		}
		root, err := filepath.Abs(msg.CareerOpsPath)
		if err != nil {
			return screens.PipelinePDFGeneratedMsg{Err: err.Error()}
		}
		pdfAbs := filepath.Join(root, filepath.FromSlash(msg.PDFPath))
		args := []string{script, filepath.Join(root, filepath.FromSlash(msg.HTMLPath)), pdfAbs}
		if msg.Format != "" {
			args = append(args, "--format="+msg.Format)
		}
		if msg.ReportNumber != "" {
			args = append(args, "--report="+msg.ReportNumber)
		}
		cmd := exec.Command("node", args...)
		cmd.Dir = filepath.Dir(script)
		cmd.Env = append(cmd.Environ(), "CAREER_OPS_ROOT="+root)
		// Preserve relative overrides before changing the child's working directory.
		if tracker := resolveEnvPath(os.Getenv("CAREER_OPS_TRACKER")); tracker != "" {
			cmd.Env = append(cmd.Env, "CAREER_OPS_TRACKER="+tracker)
		}
		if index := os.Getenv("CAREER_OPS_PDF_INDEX"); index != "" {
			absolute, err := filepath.Abs(index)
			if err != nil {
				return screens.PipelinePDFGeneratedMsg{Err: err.Error()}
			}
			cmd.Env = append(cmd.Env, "CAREER_OPS_PDF_INDEX="+absolute)
		}
		out, err := cmd.CombinedOutput()
		if err != nil {
			return screens.PipelinePDFGeneratedMsg{Err: summarizeCmdError(err, out)}
		}
		if err := openWithDefaultApp(pdfAbs); err != nil {
			return screens.PipelinePDFGeneratedMsg{Err: fmt.Sprintf("PDF generated but could not open: %v", err)}
		}
		return screens.PipelinePDFGeneratedMsg{Path: pdfAbs}
	}
}

// summarizeCmdError condenses a failed command into one help-bar-sized line:
// the last non-empty output line when there is one (generate-pdf.mjs prints
// its error there), otherwise the exec error itself.
func summarizeCmdError(err error, out []byte) string {
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		if line := strings.TrimSpace(lines[i]); line != "" {
			return line
		}
	}
	return err.Error()
}

func (m appModel) View() string {
	switch m.state {
	case viewReport:
		return m.viewer.View()
	case viewProgress:
		return m.progress.View()
	case viewTasks:
		return m.tasks.View()
	case viewStats:
		return m.stats.View()
	default:
		return m.pipeline.View()
	}
}

// getRepoRoot defers to internal/data, which already walks up from cwd looking
// for path-resolver.mjs and is the function a relative CAREER_OPS_TRACKER
// resolves through.
//
// This used to be a second, shorter search — cwd and cwd's PARENT, then a
// silent fallback to cwd — so from anywhere deeper the data root and the
// tracker could anchor to different directories. One walker, one answer.
func getRepoRoot() string {
	root, err := data.FindRepoRoot()
	if err != nil {
		// The checkout could not be examined, which is not the same as not
		// being there. Say so: everything below resolves against this.
		fmt.Fprintf(os.Stderr, "Warning: %v\n", err)
	}
	if root != "" {
		return root
	}
	cwd, wdErr := os.Getwd()
	if wdErr != nil {
		return "."
	}
	return cwd
}

func resolveEnvPath(envVal string) string {
	trimmed := strings.TrimSpace(envVal)
	if trimmed == "" {
		return ""
	}
	if filepath.IsAbs(trimmed) {
		return filepath.Clean(trimmed)
	}
	root, err := data.FindRepoRoot()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Warning: %v\n", err)
	}
	if root == "" {
		// Anchoring to cwd here is a guess, and what is being guessed at is
		// which tracker to read. Getting it wrong is invisible: the dashboard
		// shows one file while every .mjs writer uses another, and neither side
		// reports anything. The guess is still made — exiting would be worse
		// for a user whose layout we cannot see — but it is said out loud, with
		// the absolute path the reader can check.
		cwd, wdErr := os.Getwd()
		if wdErr != nil {
			return filepath.Clean(trimmed)
		}
		resolved := filepath.Clean(filepath.Join(cwd, trimmed))
		fmt.Fprintf(os.Stderr,
			"Warning: no career-ops checkout found above the working directory or the executable, "+
				"so the relative path %q was resolved against the working directory: %s\n"+
				"         The .mjs scripts resolve it against the repository root, so they may be using a "+
				"different tracker. Pass an absolute path or --path to be sure.\n",
			trimmed, resolved)
		return resolved
	}
	return filepath.Clean(filepath.Join(root, trimmed))
}

func main() {
	defaultPath := getRepoRoot()
	if envPath := resolveEnvPath(os.Getenv("CAREER_OPS_ROOT")); envPath != "" {
		defaultPath = envPath
	} else if envPath := resolveEnvPath(os.Getenv("CAREER_OPS_DATA_DIR")); envPath != "" {
		defaultPath = envPath
	} else {
		markerFile := filepath.Join(getRepoRoot(), ".career-ops-data")
		if content, err := os.ReadFile(markerFile); err == nil {
			trimmed := strings.TrimSpace(string(content))
			if trimmed != "" {
				if filepath.IsAbs(trimmed) {
					defaultPath = filepath.Clean(trimmed)
				} else {
					defaultPath = filepath.Clean(filepath.Join(getRepoRoot(), trimmed))
				}
			}
		}
	}
	pathFlag := flag.String("path", defaultPath, "Path to career-ops directory")
	langFlag := flag.String("lang", "", "Language for UI (en, tr). Defaults to auto-detect/en.")
	flag.Parse()

	if *langFlag != "" {
		i18n.SetLang(*langFlag)
	} else if os.Getenv("LANG") != "" {
		i18n.SetLang(os.Getenv("LANG"))
	}

	careerOpsPath := *pathFlag
	if *pathFlag == "." {
		careerOpsPath = findCareerOpsRoot(".")
	}

	// Reconcile cadence -> tasks before loading the UI. Best-effort: a failure
	// here (node missing, script error) should not block the dashboard.
	runSyncTasks(careerOpsPath)

	// Load applications
	apps, trackerErr := data.ParseApplications(careerOpsPath)
	if trackerErr != nil {
		// Absent is a first run and keeps the original wording. Anything else is
		// a file that IS there and could not be opened, and saying "could not
		// find" sent the user looking for a file sitting in front of them.
		if errors.Is(trackerErr, fs.ErrNotExist) {
			fmt.Fprintf(os.Stderr, "Error: could not find applications.md in %s or %s/data/\n", careerOpsPath, careerOpsPath)
		} else {
			fmt.Fprintf(os.Stderr, "Error: %v\n", trackerErr)
		}
		os.Exit(1)
	}

	// Compute metrics
	ledger, err := data.ReadStatusLedger(careerOpsPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	data.ApplyStatusDates(apps, ledger.LatestDate)
	metrics := data.ComputeMetrics(apps)
	progressMetrics := data.ComputeProgressMetrics(apps, ledger.Reached)

	// Batch-load all report summaries
	t := theme.NewTheme("auto")
	pm := screens.NewPipelineModel(t, apps, metrics, careerOpsPath, 120, 40)

	enrichArchetypes(careerOpsPath, apps, &pm)
	statsMetrics := data.ComputeStatsMetrics(apps)

	m := appModel{
		pipeline:        pm,
		careerOpsPath:   careerOpsPath,
		theme:           t,
		progressMetrics: progressMetrics,
		statsMetrics:    statsMetrics,
		evaluatedCount: func() int {
			n := 0
			for _, a := range apps {
				if a.Score > 0 {
					n++
				}
			}
			return n
		}(),
	}

	p := tea.NewProgram(m, tea.WithAltScreen())
	if _, err := p.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
}
