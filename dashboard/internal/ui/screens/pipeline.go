package screens

import (
	"fmt"
	"path/filepath"
	"sort"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"github.com/santifer/career-ops/dashboard/internal/data"
	"github.com/santifer/career-ops/dashboard/internal/model"
	"github.com/santifer/career-ops/dashboard/internal/theme"
)

// PipelineClosedMsg is emitted when the pipeline screen is dismissed.
type PipelineClosedMsg struct{}

// PipelineOpenReportMsg is emitted when a report should be opened in FileViewer.
type PipelineOpenReportMsg struct {
	Path          string
	Title         string
	JobURL        string
	App           model.CareerApplication
	CareerOpsPath string
}

// PipelineOpenURLMsg is emitted when a job URL should be opened in browser.
type PipelineOpenURLMsg struct {
	URL string
}

// PipelineLoadReportMsg requests lazy loading of a report summary.
type PipelineLoadReportMsg struct {
	CareerOpsPath string
	ReportPath    string
}

// PipelineUpdateStatusMsg requests a status update for an application.
type PipelineUpdateStatusMsg struct {
	CareerOpsPath string
	App           model.CareerApplication
	NewStatus     string
}

// PipelineRefreshMsg requests a full tracker reload from disk.
type PipelineRefreshMsg struct{}

// PipelineOpenProgressMsg is emitted when the progress screen should open.
type PipelineOpenProgressMsg struct{}

// PipelineOpenTasksMsg is emitted when the tasks screen should open.
type PipelineOpenTasksMsg struct{}

// PipelineBulkUpdateStatusMsg requests the same status change applied to
// multiple applications in one go. Main reuses the single-row code path
// per app so the Interview thank-you cascade fires for each one.
type PipelineBulkUpdateStatusMsg struct {
	CareerOpsPath string
	Apps          []model.CareerApplication
	NewStatus     string
}

// PipelineAddTaskMsg requests creation of a manual task linked to an
// application. Due may be empty for no due date.
type PipelineAddTaskMsg struct {
	App   model.CareerApplication
	Title string
	Due   string // YYYY-MM-DD or "" for none
}

type reportSummary struct {
	archetype string
	tldr      string
	remote    string
	comp      string
}

// Sort modes
const (
	sortScore   = "score"
	sortDate    = "date"
	sortCompany = "company"
	sortStatus  = "status"
)

// Filter modes
const (
	filterAll       = "all"
	filterEvaluated = "evaluated"
	filterApplied   = "applied"
	filterInterview = "interview"
	filterSkip      = "skip"
	filterRejected  = "rejected"
	filterDiscarded = "discarded"
	filterTop       = "top"
)

type pipelineTab struct {
	filter string
	label  string
}

var pipelineTabs = []pipelineTab{
	{filterAll, "ALL"},
	{filterEvaluated, "EVALUATED"},
	{filterApplied, "APPLIED"},
	{filterInterview, "INTERVIEW"},
	{filterTop, "TOP ≥4"},
	{filterSkip, "SKIP"},
	{filterRejected, "REJECTED"},
	{filterDiscarded, "DISCARDED"},
}

var sortCycle = []string{sortScore, sortDate, sortCompany, sortStatus}

type statusOption struct {
	label    string
	shortcut string // key that selects this option in the picker
}

var statusOptions = []statusOption{
	{"Evaluated", "e"},
	{"Applied", "a"},
	{"Responded", "r"},
	{"Interview", "i"},
	{"Offer", "o"},
	{"Rejected", "x"}, // x not r — r is taken by Responded
	{"Discarded", "d"},
	{"SKIP", "s"},
}

// statusGroupOrder defines display order for grouped view.
var statusGroupOrder = []string{"interview", "offer", "responded", "applied", "evaluated", "skip", "rejected", "discarded"}

// PipelineModel implements the career pipeline dashboard screen.
type PipelineModel struct {
	apps          []model.CareerApplication
	filtered      []model.CareerApplication
	metrics       model.PipelineMetrics
	cursor        int
	scrollOffset  int
	sortMode      string
	activeTab     int
	viewMode      string // "grouped" or "flat"
	width, height int
	theme         theme.Theme
	careerOpsPath string
	reportCache   map[string]reportSummary
	// Status picker sub-state
	statusPicker bool
	statusCursor int
	// Add-task prompt sub-state — shared with the report viewer so the two
	// entry points behave identically. See add_task_prompt.go.
	addTask addTaskPrompt
	// selected is the set of tracker numbers in the current multi-select.
	// When non-empty, the status picker applies to all selected rows
	// instead of the cursor row. Cleared after a bulk apply or when the
	// active tab changes (so selections always reflect rows visible in the
	// current filter — the ALL tab is the cross-status starting point).
	selected map[int]bool
}

// NewPipelineModel creates a new pipeline screen.
func NewPipelineModel(t theme.Theme, apps []model.CareerApplication, metrics model.PipelineMetrics, careerOpsPath string, width, height int) PipelineModel {
	m := PipelineModel{
		apps:          apps,
		metrics:       metrics,
		sortMode:      sortScore,
		activeTab:     0,
		viewMode:      "grouped",
		width:         width,
		height:        height,
		theme:         t,
		careerOpsPath: careerOpsPath,
		reportCache:   make(map[string]reportSummary),
	}
	m.applyFilterAndSort()
	return m
}

// Init implements tea.Model.
func (m PipelineModel) Init() tea.Cmd {
	return nil
}

// Resize updates dimensions.
func (m *PipelineModel) Resize(width, height int) {
	m.width = width
	m.height = height
}

// Width returns the current width.
func (m PipelineModel) Width() int { return m.width }

// Height returns the current height.
func (m PipelineModel) Height() int { return m.height }

// CopyReportCache copies the report cache from another pipeline model.
func (m *PipelineModel) CopyReportCache(other *PipelineModel) {
	for k, v := range other.reportCache {
		m.reportCache[k] = v
	}
}

// EnrichReport caches report summary data for preview.
func (m *PipelineModel) EnrichReport(reportPath, archetype, tldr, remote, comp string) {
	m.reportCache[reportPath] = reportSummary{
		archetype: archetype,
		tldr:      tldr,
		remote:    remote,
		comp:      comp,
	}
}

// WithReloadedData rebuilds the pipeline with fresh tracker data while preserving
// the current UI state so manual refresh feels seamless.
func (m PipelineModel) WithReloadedData(apps []model.CareerApplication, metrics model.PipelineMetrics) PipelineModel {
	selectedReportPath := ""
	selectedCompany := ""
	selectedRole := ""
	if app, ok := m.CurrentApp(); ok {
		selectedReportPath = app.ReportPath
		selectedCompany = app.Company
		selectedRole = app.Role
	}

	reloaded := NewPipelineModel(m.theme, apps, metrics, m.careerOpsPath, m.width, m.height)
	reloaded.sortMode = m.sortMode
	reloaded.activeTab = m.activeTab
	reloaded.viewMode = m.viewMode
	reloaded.applyFilterAndSort()
	reloaded.CopyReportCache(&m)

	for i, app := range reloaded.filtered {
		if selectedReportPath != "" && app.ReportPath == selectedReportPath {
			reloaded.cursor = i
			reloaded.adjustScroll()
			return reloaded
		}
		if selectedReportPath == "" && app.Company == selectedCompany && app.Role == selectedRole {
			reloaded.cursor = i
			reloaded.adjustScroll()
			return reloaded
		}
	}

	if len(reloaded.filtered) == 0 {
		reloaded.cursor = 0
		reloaded.scrollOffset = 0
		return reloaded
	}

	if m.cursor >= len(reloaded.filtered) {
		reloaded.cursor = len(reloaded.filtered) - 1
	} else if m.cursor > 0 {
		reloaded.cursor = m.cursor
	}
	reloaded.adjustScroll()
	return reloaded
}

// CurrentApp returns the currently selected application, if any.
func (m PipelineModel) CurrentApp() (model.CareerApplication, bool) {
	if m.cursor < 0 || m.cursor >= len(m.filtered) {
		return model.CareerApplication{}, false
	}
	return m.filtered[m.cursor], true
}

// Update handles input for the pipeline screen.
func (m PipelineModel) Update(msg tea.Msg) (PipelineModel, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyMsg:
		if m.statusPicker {
			return m.handleStatusPicker(msg)
		}
		if m.addTask.active() {
			return m.handleAddTaskInput(msg)
		}
		return m.handleKey(msg)
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		return m, nil
	}
	return m, nil
}

func (m PipelineModel) handleKey(msg tea.KeyMsg) (PipelineModel, tea.Cmd) {
	switch msg.String() {
	case "q", "esc":
		return m, func() tea.Msg { return PipelineClosedMsg{} }

	case "down", "j":
		if len(m.filtered) > 0 {
			m.cursor++
			if m.cursor >= len(m.filtered) {
				m.cursor = len(m.filtered) - 1
			}
			m.adjustScroll()
			return m, m.loadCurrentReport()
		}

	case "up", "k":
		if len(m.filtered) > 0 {
			m.cursor--
			if m.cursor < 0 {
				m.cursor = 0
			}
			m.adjustScroll()
			return m, m.loadCurrentReport()
		}

	case "s":
		// Cycle sort mode
		for i, s := range sortCycle {
			if s == m.sortMode {
				m.sortMode = sortCycle[(i+1)%len(sortCycle)]
				break
			}
		}
		m.applyFilterAndSort()
		m.cursor = 0
		m.scrollOffset = 0

	case "f", "right", "l":
		m.activeTab++
		if m.activeTab >= len(pipelineTabs) {
			m.activeTab = 0
		}
		m.applyFilterAndSort()
		m.cursor = 0
		m.scrollOffset = 0
		// Selection set is scoped to the active filter — clearing on tab
		// change keeps the visible selection honest. Use the ALL tab to
		// build a cross-status selection.
		m.selected = nil

	case "left", "h":
		m.activeTab--
		if m.activeTab < 0 {
			m.activeTab = len(pipelineTabs) - 1
		}
		m.applyFilterAndSort()
		m.cursor = 0
		m.scrollOffset = 0
		m.selected = nil

	case "v":
		if m.viewMode == "grouped" {
			m.viewMode = "flat"
		} else {
			m.viewMode = "grouped"
		}

	case "enter":
		if app, ok := m.CurrentApp(); ok && app.ReportPath != "" {
			fullPath := filepath.Join(m.careerOpsPath, app.ReportPath)
			title := fmt.Sprintf("%s — %s", app.Company, app.Role)
			jobURL := app.JobURL
			careerPath := m.careerOpsPath
			return m, func() tea.Msg {
				return PipelineOpenReportMsg{
					Path:          fullPath,
					Title:         title,
					JobURL:        jobURL,
					App:           app,
					CareerOpsPath: careerPath,
				}
			}
		}

	case "o":
		if app, ok := m.CurrentApp(); ok && app.JobURL != "" {
			return m, func() tea.Msg {
				return PipelineOpenURLMsg{URL: app.JobURL}
			}
		}

	case "p":
		return m, func() tea.Msg { return PipelineOpenProgressMsg{} }

	case "t":
		return m, func() tea.Msg { return PipelineOpenTasksMsg{} }

	case "r":
		return m, func() tea.Msg { return PipelineRefreshMsg{} }

	case "c":
		if len(m.filtered) > 0 {
			m.statusPicker = true
			m.statusCursor = 0
		}

	case " ":
		// Toggle the current row's membership in the selection set. When
		// non-empty, the status picker applies to all selected rows.
		if app, ok := m.CurrentApp(); ok && app.Number > 0 {
			if m.selected == nil {
				m.selected = make(map[int]bool)
			}
			if m.selected[app.Number] {
				delete(m.selected, app.Number)
				if len(m.selected) == 0 {
					m.selected = nil
				}
			} else {
				m.selected[app.Number] = true
			}
		}

	case "X":
		// Clear the entire selection set. Capital X to keep lowercase x
		// (Rejected) free inside the status picker.
		m.selected = nil

	case "n":
		// Add a manual task for the selected application. The two-stage
		// prompt collects title then due date so the task can carry both
		// without forcing a special syntax. Stage 2 starts at "today" so
		// the most common case is one Enter away.
		if _, ok := m.CurrentApp(); ok {
			m.addTask.open()
		}

	case "g":
		if len(m.filtered) > 0 {
			m.cursor = 0
			m.scrollOffset = 0
			return m, m.loadCurrentReport()
		}

	case "G":
		if len(m.filtered) > 0 {
			m.cursor = len(m.filtered) - 1
			m.adjustScroll()
			return m, m.loadCurrentReport()
		}

	case "pgdown", "ctrl+d":
		if len(m.filtered) > 0 {
			halfPage := m.height / 2
			if halfPage < 1 {
				halfPage = 1
			}
			m.cursor += halfPage
			if m.cursor >= len(m.filtered) {
				m.cursor = len(m.filtered) - 1
			}
			m.adjustScroll()
			return m, m.loadCurrentReport()
		}

	case "pgup", "ctrl+u":
		if len(m.filtered) > 0 {
			halfPage := m.height / 2
			if halfPage < 1 {
				halfPage = 1
			}
			m.cursor -= halfPage
			if m.cursor < 0 {
				m.cursor = 0
			}
			m.adjustScroll()
			return m, m.loadCurrentReport()
		}
	}

	return m, nil
}

func (m PipelineModel) handleStatusPicker(msg tea.KeyMsg) (PipelineModel, tea.Cmd) {
	switch msg.String() {
	case "esc", "q":
		m.statusPicker = false
		return m, nil

	case "down", "j":
		m.statusCursor++
		if m.statusCursor >= len(statusOptions) {
			m.statusCursor = len(statusOptions) - 1
		}

	case "up", "k":
		m.statusCursor--
		if m.statusCursor < 0 {
			m.statusCursor = 0
		}

	case "enter":
		m.statusPicker = false
		newStatus := statusOptions[m.statusCursor].label
		return m.dispatchStatusChange(newStatus)

	default:
		// Letter shortcut — apply the matching status directly.
		key := strings.ToLower(msg.String())
		if len(key) == 1 {
			for i, opt := range statusOptions {
				if opt.shortcut == key {
					m.statusCursor = i
					m.statusPicker = false
					return m.dispatchStatusChange(opt.label)
				}
			}
		}
	}
	return m, nil
}

// dispatchStatusChange emits either a bulk or single status-update message
// depending on whether the multi-select is active. The selection set is
// cleared here so the rows can't be re-applied on a subsequent picker open.
func (m PipelineModel) dispatchStatusChange(newStatus string) (PipelineModel, tea.Cmd) {
	if len(m.selected) > 0 {
		targets := make([]model.CareerApplication, 0, len(m.selected))
		for _, app := range m.apps {
			if m.selected[app.Number] {
				targets = append(targets, app)
			}
		}
		path := m.careerOpsPath
		m.selected = nil
		return m, func() tea.Msg {
			return PipelineBulkUpdateStatusMsg{
				CareerOpsPath: path,
				Apps:          targets,
				NewStatus:     newStatus,
			}
		}
	}
	if app, ok := m.CurrentApp(); ok {
		return m, func() tea.Msg {
			return PipelineUpdateStatusMsg{
				CareerOpsPath: m.careerOpsPath,
				App:           app,
				NewStatus:     newStatus,
			}
		}
	}
	return m, nil
}

// handleAddTaskInput routes a key into the shared add-task prompt. On submit
// (Enter at stage 2), resolves the offset and emits PipelineAddTaskMsg.
func (m PipelineModel) handleAddTaskInput(msg tea.KeyMsg) (PipelineModel, tea.Cmd) {
	if !m.addTask.handleKey(msg) {
		return m, nil
	}
	app, ok := m.CurrentApp()
	if !ok {
		m.addTask.close()
		return m, nil
	}
	title := m.addTask.Title()
	due := m.addTask.ResolvedDue()
	m.addTask.close()
	return m, func() tea.Msg {
		return PipelineAddTaskMsg{App: app, Title: title, Due: due}
	}
}

func (m PipelineModel) loadCurrentReport() tea.Cmd {
	app, ok := m.CurrentApp()
	if !ok || app.ReportPath == "" {
		return nil
	}
	if _, cached := m.reportCache[app.ReportPath]; cached {
		return nil
	}
	path := m.careerOpsPath
	report := app.ReportPath
	return func() tea.Msg {
		return PipelineLoadReportMsg{CareerOpsPath: path, ReportPath: report}
	}
}

// applyFilterAndSort rebuilds the filtered list from apps.
func (m *PipelineModel) applyFilterAndSort() {
	var filtered []model.CareerApplication

	currentFilter := pipelineTabs[m.activeTab].filter
	for _, app := range m.apps {
		norm := data.NormalizeStatus(app.Status)
		switch currentFilter {
		case filterAll:
			filtered = append(filtered, app)
		case filterTop:
			if app.Score >= 4.0 && norm != "skip" {
				filtered = append(filtered, app)
			}
		default:
			if norm == currentFilter {
				filtered = append(filtered, app)
			}
		}
	}

	// Sort
	switch m.sortMode {
	case sortScore:
		sort.SliceStable(filtered, func(i, j int) bool {
			return filtered[i].Score > filtered[j].Score
		})
	case sortDate:
		sort.SliceStable(filtered, func(i, j int) bool {
			return filtered[i].Date > filtered[j].Date
		})
	case sortCompany:
		sort.SliceStable(filtered, func(i, j int) bool {
			return strings.ToLower(filtered[i].Company) < strings.ToLower(filtered[j].Company)
		})
	case sortStatus:
		sort.SliceStable(filtered, func(i, j int) bool {
			return data.StatusPriority(filtered[i].Status) < data.StatusPriority(filtered[j].Status)
		})
	}

	// In grouped mode, always sort by status priority first, then by selected sort within groups
	if m.viewMode == "grouped" {
		sort.SliceStable(filtered, func(i, j int) bool {
			pi := data.StatusPriority(filtered[i].Status)
			pj := data.StatusPriority(filtered[j].Status)
			if pi != pj {
				return pi < pj
			}
			// Within same group, use selected sort
			switch m.sortMode {
			case sortScore:
				return filtered[i].Score > filtered[j].Score
			case sortDate:
				return filtered[i].Date > filtered[j].Date
			case sortCompany:
				return strings.ToLower(filtered[i].Company) < strings.ToLower(filtered[j].Company)
			default:
				return filtered[i].Score > filtered[j].Score
			}
		})
	}

	m.filtered = filtered
}

// adjustScroll updates scrollOffset so the cursor stays visible.
func (m *PipelineModel) adjustScroll() {
	availHeight := m.height - 12 // header + tabs(2) + metrics + sortbar + footer + preview
	if availHeight < 5 {
		availHeight = 5
	}
	line := m.cursorLineEstimate()
	margin := 3

	if line >= m.scrollOffset+availHeight-margin {
		m.scrollOffset = line - availHeight + margin + 1
	}
	if line < m.scrollOffset+margin {
		m.scrollOffset = line - margin
	}
	if m.scrollOffset < 0 {
		m.scrollOffset = 0
	}
}

func (m PipelineModel) cursorLineEstimate() int {
	if m.viewMode != "grouped" {
		return m.cursor
	}
	// Account for group headers
	line := 0
	prevStatus := ""
	for i, app := range m.filtered {
		norm := data.NormalizeStatus(app.Status)
		if norm != prevStatus {
			line++ // group header
			prevStatus = norm
		}
		if i == m.cursor {
			return line
		}
		line++
	}
	return line
}

// -- View --

// View renders the pipeline screen.
func (m PipelineModel) View() string {
	header := m.renderHeader()
	tabs := m.renderTabs()
	metricsBar := m.renderMetrics()
	sortBar := m.renderSortBar()
	body := m.renderBody()
	preview := m.renderPreview()
	help := m.renderHelp()

	// Apply scroll to body
	bodyLines := strings.Split(body, "\n")
	if m.scrollOffset > 0 && m.scrollOffset < len(bodyLines) {
		bodyLines = bodyLines[m.scrollOffset:]
	}

	// Calculate available height for body
	previewLines := strings.Count(preview, "\n") + 1
	availHeight := m.height - 7 - previewLines // header + tabs(2) + metrics + sortbar + help + preview
	if availHeight < 3 {
		availHeight = 3
	}
	if len(bodyLines) > availHeight {
		bodyLines = bodyLines[:availHeight]
	}
	body = strings.Join(bodyLines, "\n")

	// Status picker overlay
	if m.statusPicker {
		body = m.overlayStatusPicker(body)
	}
	if m.addTask.active() {
		body = m.overlayAddTaskPrompt(body)
	}

	return lipgloss.JoinVertical(lipgloss.Left,
		header,
		tabs,
		metricsBar,
		sortBar,
		body,
		preview,
		help,
	)
}

func (m PipelineModel) renderHeader() string {
	style := lipgloss.NewStyle().
		Bold(true).
		Foreground(m.theme.Text).
		Background(m.theme.Surface).
		Width(m.width).
		Padding(0, 2)

	right := lipgloss.NewStyle().Foreground(m.theme.Subtext)
	avg := fmt.Sprintf("%.1f", m.metrics.AvgScore)
	info := right.Render(fmt.Sprintf("%d offers | Avg %s/5", m.metrics.Total, avg))

	title := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Blue).Render("CAREER PIPELINE")
	gap := m.width - lipgloss.Width(title) - lipgloss.Width(info) - 4
	if gap < 1 {
		gap = 1
	}

	return style.Render(title + strings.Repeat(" ", gap) + info)
}

func (m PipelineModel) renderTabs() string {
	var tabs []string
	var underParts []string

	for i, tab := range pipelineTabs {
		// Count items for this tab
		count := m.countForFilter(tab.filter)
		label := fmt.Sprintf(" %s (%d) ", tab.label, count)

		if i == m.activeTab {
			style := lipgloss.NewStyle().
				Bold(true).
				Foreground(m.theme.Blue).
				Padding(0, 0)
			tabs = append(tabs, style.Render(label))
			underParts = append(underParts, strings.Repeat("━", lipgloss.Width(label)))
		} else {
			style := lipgloss.NewStyle().
				Foreground(m.theme.Subtext).
				Padding(0, 0)
			tabs = append(tabs, style.Render(label))
			underParts = append(underParts, strings.Repeat("─", lipgloss.Width(label)))
		}
	}

	row := lipgloss.JoinHorizontal(lipgloss.Top, tabs...)
	underline := lipgloss.NewStyle().Foreground(m.theme.Overlay).Render(strings.Join(underParts, ""))

	padStyle := lipgloss.NewStyle().Padding(0, 1)
	return padStyle.Render(row) + "\n" + padStyle.Render(underline)
}

func (m PipelineModel) countForFilter(filter string) int {
	count := 0
	for _, app := range m.apps {
		norm := data.NormalizeStatus(app.Status)
		switch filter {
		case filterAll:
			count++
		case filterTop:
			if app.Score >= 4.0 && norm != "skip" {
				count++
			}
		default:
			if norm == filter {
				count++
			}
		}
	}
	return count
}

func (m PipelineModel) renderMetrics() string {
	style := lipgloss.NewStyle().
		Background(m.theme.Surface).
		Width(m.width).
		Padding(0, 2)

	var parts []string
	statusColors := m.statusColorMap()

	for _, status := range statusGroupOrder {
		count, ok := m.metrics.ByStatus[status]
		if !ok || count == 0 {
			continue
		}
		color := statusColors[status]
		s := lipgloss.NewStyle().Foreground(color)
		parts = append(parts, s.Render(fmt.Sprintf("%s:%d", statusLabel(status), count)))
	}

	// Surface the active multi-select count so the user has unambiguous
	// confirmation of "the next 'c' will hit N rows, not just the cursor".
	if n := len(m.selected); n > 0 {
		selStyle := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Mauve)
		parts = append(parts, selStyle.Render(fmt.Sprintf("[%d selected]", n)))
	}

	return style.Render(strings.Join(parts, "  "))
}

func (m PipelineModel) renderSortBar() string {
	style := lipgloss.NewStyle().
		Foreground(m.theme.Subtext).
		Width(m.width).
		Padding(0, 2)

	sortLabel := fmt.Sprintf("[Sort: %s]", m.sortMode)
	viewLabel := fmt.Sprintf("[View: %s]", m.viewMode)
	count := fmt.Sprintf("%d shown", len(m.filtered))

	return style.Render(fmt.Sprintf("%s  %s  %s", sortLabel, viewLabel, count))
}

func (m PipelineModel) renderBody() string {
	if len(m.filtered) == 0 {
		emptyStyle := lipgloss.NewStyle().
			Foreground(m.theme.Subtext).
			Padding(1, 2)
		return emptyStyle.Render("No offers match this filter")
	}

	var lines []string
	prevStatus := ""
	padStyle := lipgloss.NewStyle().Padding(0, 2)

	for i, app := range m.filtered {
		norm := data.NormalizeStatus(app.Status)

		// Group header in grouped mode
		if m.viewMode == "grouped" && norm != prevStatus {
			count := m.countByNormStatus(norm)
			headerStyle := lipgloss.NewStyle().
				Bold(true).
				Foreground(m.theme.Subtext)
			lines = append(lines, padStyle.Render(
				headerStyle.Render(fmt.Sprintf("── %s (%d) %s",
					strings.ToUpper(statusLabel(norm)), count,
					strings.Repeat("─", max(0, m.width-30-len(statusLabel(norm)))))),
			))
			prevStatus = norm
		}

		selected := i == m.cursor
		line := m.renderAppLine(app, selected)
		lines = append(lines, line)
	}

	return strings.Join(lines, "\n")
}

func (m PipelineModel) renderAppLine(app model.CareerApplication, selected bool) string {
	padStyle := lipgloss.NewStyle().Padding(0, 2)

	// Column widths
	numW := 5   // "#123 "
	scoreW := 5 // "4.5  "
	dateW := 10
	companyW := 16
	statusW := 12
	compW := 14
	// Role gets remaining space
	roleW := m.width - numW - scoreW - dateW - companyW - statusW - compW - 13
	if roleW < 15 {
		roleW = 15
	}

	// Tracker number (fixed width)
	numText := "#—"
	if app.Number > 0 {
		numText = fmt.Sprintf("#%d", app.Number)
	}
	numStyle := lipgloss.NewStyle().Foreground(m.theme.Blue).Bold(true).Width(numW)

	// Score with color
	scoreStyle := m.scoreStyle(app.Score)
	score := scoreStyle.Render(fmt.Sprintf("%.1f", app.Score))

	// Company (truncate)
	company := truncateRunes(app.Company, companyW)
	companyStyle := lipgloss.NewStyle().Foreground(m.theme.Text).Width(companyW)

	// Date (fixed width)
	dateText := app.Date
	if dateText == "" {
		dateText = "—"
	}
	dateStyle := lipgloss.NewStyle().Foreground(m.theme.Subtext).Width(dateW)

	// Role (truncate)
	role := truncateRunes(app.Role, roleW)
	roleStyle := lipgloss.NewStyle().Foreground(m.theme.Subtext).Width(roleW)

	// Status with color -- fixed column
	norm := data.NormalizeStatus(app.Status)
	statusColor := m.statusColorMap()[norm]
	statusStyle := lipgloss.NewStyle().Foreground(statusColor).Width(statusW)
	statusText := statusStyle.Render(statusLabel(norm))

	// Comp from report cache -- fixed column
	compText := ""
	if summary, ok := m.reportCache[app.ReportPath]; ok && summary.comp != "" {
		comp := truncateRunes(summary.comp, compW-1)
		compStyle := lipgloss.NewStyle().Foreground(m.theme.Yellow)
		compText = compStyle.Render(comp)
	}

	line := fmt.Sprintf(" %s %s %s %s %s %s %s",
		numStyle.Render(truncateRunes(numText, numW)),
		score,
		dateStyle.Render(truncateRunes(dateText, dateW)),
		companyStyle.Render(company),
		roleStyle.Render(role),
		statusText,
		compText,
	)

	// Two independent highlights:
	//   - cursor: the row the user is navigating (always Overlay bg).
	//   - multi: the row is in the selection set for a bulk action.
	// When both fire on the same row, the cursor color wins on background
	// but Bold signals that this row is also part of the selection.
	multi := m.selected[app.Number]
	switch {
	case selected && multi:
		s := lipgloss.NewStyle().Background(m.theme.Overlay).Bold(true).Width(m.width - 4)
		return padStyle.Render(s.Render(line))
	case selected:
		s := lipgloss.NewStyle().Background(m.theme.Overlay).Width(m.width - 4)
		return padStyle.Render(s.Render(line))
	case multi:
		// A muted mauve — distinct hue from the Blue tracker number so the
		// "#" column stays readable. Surface (#313244) is the same hue
		// family as Blue (#89b4fa) and made the number hard to read on
		// selected rows even with adequate luminance contrast.
		s := lipgloss.NewStyle().Background(selectedRowBg).Width(m.width - 4)
		return padStyle.Render(s.Render(line))
	}
	return padStyle.Render(line)
}

// selectedRowBg is the background applied to rows in the multi-select set.
// Chosen for hue separation from the Blue accent (the tracker-number color)
// rather than maximum luminance contrast — both backgrounds satisfy WCAG
// against the row's foregrounds, but blue-on-blue read as "low contrast" to
// the eye. Muted mauve in the catppuccin family keeps the theme feel.
var selectedRowBg = lipgloss.Color("#4a3a5e")

func (m PipelineModel) renderPreview() string {
	app, ok := m.CurrentApp()
	if !ok {
		return ""
	}

	padStyle := lipgloss.NewStyle().Padding(0, 2)
	divider := lipgloss.NewStyle().Foreground(m.theme.Overlay)

	var lines []string
	lines = append(lines, padStyle.Render(divider.Render(strings.Repeat("─", m.width-4))))

	labelStyle := lipgloss.NewStyle().Foreground(m.theme.Sky).Bold(true)
	valueStyle := lipgloss.NewStyle().Foreground(m.theme.Text)
	dimStyle := lipgloss.NewStyle().Foreground(m.theme.Subtext)

	// Check report cache
	if summary, ok := m.reportCache[app.ReportPath]; ok {
		if summary.archetype != "" {
			lines = append(lines, padStyle.Render(
				labelStyle.Render("Arquetipo: ")+valueStyle.Render(summary.archetype)))
		}
		if summary.tldr != "" {
			lines = append(lines, padStyle.Render(
				labelStyle.Render("TL;DR: ")+valueStyle.Render(summary.tldr)))
		}
		if summary.comp != "" {
			lines = append(lines, padStyle.Render(
				labelStyle.Render("Comp: ")+valueStyle.Render(summary.comp)))
		}
		if summary.remote != "" {
			lines = append(lines, padStyle.Render(
				labelStyle.Render("Remote: ")+valueStyle.Render(summary.remote)))
		}
	} else if app.Notes != "" {
		// Fallback: show notes
		notes := truncateRunes(app.Notes, m.width-10)
		lines = append(lines, padStyle.Render(dimStyle.Render(notes)))
	} else {
		lines = append(lines, padStyle.Render(dimStyle.Render("Loading preview...")))
	}

	return strings.Join(lines, "\n")
}

func (m PipelineModel) renderHelp() string {
	style := lipgloss.NewStyle().
		Foreground(m.theme.Subtext).
		Background(m.theme.Surface).
		Width(m.width).
		Padding(0, 1)

	keyStyle := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Text)
	descStyle := lipgloss.NewStyle().Foreground(m.theme.Subtext)

	if m.statusPicker {
		return style.Render(
			keyStyle.Render("↑↓/jk") + descStyle.Render(" navigate  ") +
				keyStyle.Render("Enter") + descStyle.Render(" confirm  ") +
				keyStyle.Render("Esc") + descStyle.Render(" cancel"))
	}
	if m.addTask.active() {
		return style.Render(
			keyStyle.Render("type") + descStyle.Render(" input  ") +
				keyStyle.Render("↑↓") + descStyle.Render(" ±day  ") +
				keyStyle.Render("Enter") + descStyle.Render(" next/save  ") +
				keyStyle.Render("Esc") + descStyle.Render(" cancel"))
	}

	brand := lipgloss.NewStyle().Foreground(m.theme.Overlay).Render("career-ops by santifer.io")

	// When the multi-select is active, swap the right-hand cluster to
	// emphasise the bulk path (and the clear shortcut) so the user can
	// see how to confirm or abandon the selection.
	var actionKeys string
	if len(m.selected) > 0 {
		actionKeys = keyStyle.Render("Space") + descStyle.Render(" toggle  ") +
			keyStyle.Render("c") + descStyle.Render(" bulk change  ") +
			keyStyle.Render("X") + descStyle.Render(" clear sel  ")
	} else {
		actionKeys = keyStyle.Render("c") + descStyle.Render(" change  ") +
			keyStyle.Render("Space") + descStyle.Render(" select  ") +
			keyStyle.Render("n") + descStyle.Render(" new task  ")
	}

	keys := keyStyle.Render("↑↓/jk") + descStyle.Render(" nav  ") +
		keyStyle.Render("←→/hl") + descStyle.Render(" tabs  ") +
		keyStyle.Render("s") + descStyle.Render(" sort  ") +
		keyStyle.Render("r") + descStyle.Render(" refresh  ") +
		keyStyle.Render("Enter") + descStyle.Render(" report  ") +
		keyStyle.Render("o") + descStyle.Render(" open URL  ") +
		actionKeys +
		keyStyle.Render("v") + descStyle.Render(" view  ") +
		keyStyle.Render("p") + descStyle.Render(" progress  ") +
		keyStyle.Render("t") + descStyle.Render(" tasks  ") +
		keyStyle.Render("Esc") + descStyle.Render(" quit")

	gap := m.width - lipgloss.Width(keys) - lipgloss.Width(brand) - 2
	if gap < 1 {
		gap = 1
	}

	return style.Render(keys + strings.Repeat(" ", gap) + brand)
}

func (m PipelineModel) overlayStatusPicker(body string) string {
	// Compact bordered box. The cursor option uses Reverse video (the
	// terminal's native invert-colors) instead of Bold + Background +
	// Width — that combo caused mid-glyph clipping for some option
	// labels ("Responded" was rendering as "E   DED" in the user's
	// terminal). Reverse is supported reliably everywhere.
	bodyLines := strings.Split(body, "\n")

	padStyle := lipgloss.NewStyle().Padding(0, 2)
	titleStyle := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Blue)
	dimStyle := lipgloss.NewStyle().Foreground(m.theme.Text)
	cursorStyle := lipgloss.NewStyle().Foreground(m.theme.Text).Reverse(true)

	title := "Change status:"
	if n := len(m.selected); n > 0 {
		title = fmt.Sprintf("Change status for %d apps:", n)
	}

	var content []string
	content = append(content, titleStyle.Render(title))
	for i, opt := range statusOptions {
		prefix := "  "
		style := dimStyle
		if i == m.statusCursor {
			prefix = "▶ "
			style = cursorStyle
		}
		label := fmt.Sprintf("%s (%s)", opt.label, strings.ToUpper(opt.shortcut))
		content = append(content, style.Render(prefix+label))
	}

	box := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(m.theme.Blue).
		Padding(0, 1).
		Render(strings.Join(content, "\n"))

	for _, line := range strings.Split(box, "\n") {
		bodyLines = append(bodyLines, padStyle.Render(line))
	}
	return strings.Join(bodyLines, "\n")
}

// overlayAddTaskPrompt renders the shared two-stage new-task prompt at the
// bottom of the body. The actual layout lives in addTaskPrompt.render; this
// just resolves the target label from the currently-selected application.
func (m PipelineModel) overlayAddTaskPrompt(body string) string {
	// Defensive: if the cursor moved off the only filtered row before the
	// prompt got rendered, just pass the body through. The 'n' handler
	// guards against opening the prompt without an app, but state could
	// shift under a future refactor.
	app, ok := m.CurrentApp()
	if !ok {
		return body
	}
	target := fmt.Sprintf("#%d %s", app.Number, app.Company)
	if app.Number == 0 {
		target = app.Company
	}
	return m.addTask.render(body, m.theme, target)
}

// -- Helpers --

func (m PipelineModel) scoreStyle(score float64) lipgloss.Style {
	switch {
	case score >= 4.2:
		return lipgloss.NewStyle().Foreground(m.theme.Green).Bold(true)
	case score >= 3.8:
		return lipgloss.NewStyle().Foreground(m.theme.Yellow)
	case score >= 3.0:
		return lipgloss.NewStyle().Foreground(m.theme.Text)
	default:
		return lipgloss.NewStyle().Foreground(m.theme.Red)
	}
}

func (m PipelineModel) statusColorMap() map[string]lipgloss.Color {
	return map[string]lipgloss.Color{
		"interview": m.theme.Green,
		"offer":     m.theme.Green,
		"applied":   m.theme.Sky,
		"responded": m.theme.Blue,
		"evaluated": m.theme.Text,
		"skip":      m.theme.Red,
		"rejected":  m.theme.Subtext,
		"discarded": m.theme.Subtext,
	}
}

func (m PipelineModel) countByNormStatus(status string) int {
	count := 0
	for _, app := range m.filtered {
		if data.NormalizeStatus(app.Status) == status {
			count++
		}
	}
	return count
}

// truncateRunes truncates a string to at most maxRunes runes, appending "..." if truncated.
func truncateRunes(s string, maxRunes int) string {
	runes := []rune(s)
	if len(runes) <= maxRunes {
		return s
	}
	if maxRunes <= 3 {
		return string(runes[:maxRunes])
	}
	return string(runes[:maxRunes-3]) + "..."
}

func statusLabel(norm string) string {
	switch norm {
	case "interview":
		return "Interview"
	case "offer":
		return "Offer"
	case "responded":
		return "Responded"
	case "applied":
		return "Applied"
	case "evaluated":
		return "Evaluated"
	case "skip":
		return "Skip"
	case "rejected":
		return "Rejected"
	case "discarded":
		return "Discarded"
	default:
		return norm
	}
}
