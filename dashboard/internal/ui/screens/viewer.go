package screens

import (
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"unicode/utf8"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/charmbracelet/lipgloss/table"
	"github.com/charmbracelet/x/ansi"

	"github.com/santifer/career-ops/dashboard/internal/data"
	"github.com/santifer/career-ops/dashboard/internal/i18n"
	"github.com/santifer/career-ops/dashboard/internal/model"
	"github.com/santifer/career-ops/dashboard/internal/theme"
)

// ViewerClosedMsg is emitted when the viewer is dismissed.
type ViewerClosedMsg struct{}

// ViewerOpenTasksMsg is emitted when the user wants to jump from the viewer
// to the tasks list, focused on the first task for the current application.
type ViewerOpenTasksMsg struct {
	AppNumber int
}

// ViewerOpenCoverLetterMsg is emitted when the user requests to open the cover letter PDF.
type ViewerOpenCoverLetterMsg struct{ Path string }

// ViewerUpdateStatusMsg is emitted when a status update is requested from the
// viewer. main.go routes it through the same Hired / discard-reason flows the
// pipeline screen uses, so both entry points behave identically.
type ViewerUpdateStatusMsg struct {
	App       model.CareerApplication
	NewStatus string
}

// UpdateAppStatus updates the status of the current application inside the viewer model.
func (m *ViewerModel) UpdateAppStatus(newStatus string) {
	m.app.Status = newStatus
}

// ViewerModel implements an integrated file viewer screen.
//
// `lines` is the raw file content split on newlines; `renderedLines` is the
// width-aware rendered output (markdown tables, code blocks, wrapped
// paragraphs) produced by renderAll(). Re-rendered on Resize.
type ViewerModel struct {
	lines           []string
	renderedLines   []string
	title           string
	scrollOffset    int
	width           int
	height          int
	theme           theme.Theme
	app             model.CareerApplication
	careerOpsPath   string
	coverLetterPath string
	jobURL          string
	hasApp          bool
	statusPicker    bool
	statusCursor    int
	// rawReport is the report file content exactly as read from disk — before
	// the tasks header is prepended to `lines`. It (and the deep-research
	// prompt extracted from it) back the clipboard-copy action so a yank
	// reproduces the report, not the rendered task table.
	rawReport  string
	deepPrompt string
	// flash is a one-shot notice rendered in place of the footer (e.g. the
	// result of a clipboard copy), cleared on the next key press (same
	// contract as the pipeline screen's flash).
	flash string
	// Add-task prompt sub-state — shared helper used by both pipeline and
	// viewer so the keystroke + flow is identical between the two.
	addTask addTaskPrompt
}

// NewViewerModel creates a new file viewer for the given path.
// If app.ReportPath is non-empty, the viewer enables in-place status changes.
// tasks is the list of tasks linked to this application (filtered by App#);
// the viewer renders them as a markdown table prepended to the report body so
// the user can review all open work on this application at a glance.
func NewViewerModel(t theme.Theme, careerOpsPath, path, title string, width, height int, app model.CareerApplication, tasks ...model.Task) ViewerModel {
	content, err := os.ReadFile(path)
	if err != nil {
		content = []byte("Error reading file: " + err.Error())
	}

	raw := string(content)
	var lines []string
	if len(content) > 0 {
		lines = strings.Split(raw, "\n")
	}
	if len(tasks) > 0 {
		lines = append(buildTasksHeader(tasks), lines...)
	}
	for i, line := range lines {
		lines[i] = data.SanitizeTerminalText(line)
	}

	m := ViewerModel{
		lines:           lines,
		title:           data.SanitizeTerminalText(title),
		width:           width,
		height:          height,
		theme:           t,
		app:             app,
		careerOpsPath:   careerOpsPath,
		coverLetterPath: parseCoverLetterPath(lines, careerOpsPath),
		jobURL:          resolveJobURL(app, lines),
		hasApp:          app.ReportPath != "" || app.Company != "",
		rawReport:       raw,
		deepPrompt:      extractDeepPrompt(raw),
	}
	m.rebuildRender()
	return m
}

// buildTasksHeader produces the markdown lines for the "Tasks for this
// application" panel rendered at the top of the report viewer. The existing
// renderTableBlock turns the table into a properly formatted box.
func buildTasksHeader(tasks []model.Task) []string {
	pending, done, skipped := 0, 0, 0
	for _, t := range tasks {
		switch t.Status {
		case "pending":
			pending++
		case "done":
			done++
		case "skipped":
			skipped++
		}
	}
	lines := []string{
		"## Tasks for this application",
		"",
		fmt.Sprintf("**Summary:** %d pending · %d done · %d skipped", pending, done, skipped),
		"",
		"| # | Status | Type | Title | Due | Completed |",
		"|---|--------|------|-------|-----|-----------|",
	}
	for _, t := range tasks {
		due := t.Due
		if due == "" {
			due = "-"
		}
		completed := t.Completed
		if completed == "" {
			completed = "-"
		}
		lines = append(lines, fmt.Sprintf("| %d | %s | %s | %s | %s | %s |",
			t.Number, t.Status, t.Type, t.Title, due, completed))
	}
	lines = append(lines, "", "---", "")
	return lines
}

// parseCoverLetterPath scans the report lines for a "PDF generated: output/..." line
// inside a "## Cover Letter Draft" section and returns the relative path if the file exists.
func parseCoverLetterPath(lines []string, careerOpsPath string) string {
	inCoverSection := false
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "## Cover Letter Draft") {
			inCoverSection = true
			continue
		}
		if inCoverSection && strings.HasPrefix(trimmed, "## ") {
			break
		}
		if inCoverSection {
			if m := reCoverLetterPDF.FindStringSubmatch(line); m != nil {
				relPath := m[1]
				abs := filepath.Join(careerOpsPath, filepath.FromSlash(relPath))
				if _, err := os.Stat(abs); err == nil {
					return relPath
				}
			}
		}
	}
	return ""
}

// resolveJobURL returns the posting URL for the open report: the tracker row's
// JobURL when it is a usable web URL, else the first usable **URL:** header
// line in the report. Anything else (a hostless "https://?x", a local:jds/
// pointer) is skipped rather than handed to the platform opener.
func resolveJobURL(app model.CareerApplication, lines []string) string {
	if isWebURL(app.JobURL) {
		return app.JobURL
	}
	for _, line := range lines {
		if sm := reReportURLLine.FindStringSubmatch(strings.TrimSpace(line)); sm != nil && isWebURL(sm[1]) {
			return sm[1]
		}
	}
	return ""
}

// isWebURL reports whether raw is an absolute http(s) URL with a host.
func isWebURL(raw string) bool {
	u, err := url.Parse(raw)
	return err == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Host != ""
}

// rebuildRender recomputes renderedLines from raw lines using the current width.
func (m *ViewerModel) rebuildRender() {
	m.renderedLines = m.renderAll()
	m.clampScrollOffset()
}

func (m *ViewerModel) clampScrollOffset() {
	maxScroll := len(m.renderedLines) - m.bodyHeight()
	if maxScroll < 0 {
		maxScroll = 0
	}
	if m.scrollOffset > maxScroll {
		m.scrollOffset = maxScroll
	}
	if m.scrollOffset < 0 {
		m.scrollOffset = 0
	}
}

func (m ViewerModel) Init() tea.Cmd {
	return nil
}

func (m *ViewerModel) Resize(width, height int) {
	m.width = width
	m.height = height
	m.rebuildRender()
}

func (m ViewerModel) Update(msg tea.Msg) (ViewerModel, tea.Cmd) {
	switch msg := msg.(type) {
	case viewerCopyResultMsg:
		switch {
		case msg.err != nil:
			m.flash = "Copy failed: " + msg.err.Error()
		case msg.withPrompt:
			m.flash = "Copied deep prompt + evaluation to clipboard"
		default:
			m.flash = "Copied evaluation to clipboard (no deep prompt in report)"
		}
		return m, nil

	case StatusUpdateFailedMsg:
		m.flash = "Could not update status: " + msg.Err
		return m, nil

	case tea.KeyMsg:
		// Any keystroke dismisses a lingering flash so it never sticks around
		// past the action that produced it.
		m.flash = ""
		if m.statusPicker {
			return m.handleStatusPicker(msg)
		}
		if m.addTask.active() {
			return m.handleAddTaskInput(msg)
		}
		switch msg.String() {
		case "q", "esc":
			return m, func() tea.Msg { return ViewerClosedMsg{} }

		case "y":
			// Yank the report to the clipboard. When the report embeds a
			// deep-research prompt (score cleared the threshold at eval time),
			// the prompt leads and the evaluation follows as context.
			payload, withPrompt := m.clipboardPayload()
			if strings.TrimSpace(payload) == "" {
				m.flash = "Nothing to copy"
				return m, nil
			}
			return m, func() tea.Msg {
				return viewerCopyResultMsg{withPrompt: withPrompt, err: copyToClipboard(payload)}
			}

		case "o":
			// Open the job posting: the tracker URL, else the report's own
			// **URL:** header (resolveJobURL).
			if m.jobURL == "" {
				m.flash = "No URL found for this application"
				break
			}
			url := m.jobURL
			return m, func() tea.Msg { return PipelineOpenURLMsg{URL: url} }

		case "c":
			if m.hasApp {
				m.statusPicker = true
				m.statusCursor = 0
				currentNorm := data.NormalizeStatus(m.app.Status)
				// Compare through NormalizeStatus: it returns the lowercase
				// canonical form, so matching pair.Canonical ("Hired") raw
				// would never hit and the picker would open unpositioned.
				for idx, pair := range m.currentStatusPairs() {
					if data.NormalizeStatus(pair.Canonical) == currentNorm {
						m.statusCursor = idx
						break
					}
				}
				m.clampScrollOffset()
			}

		case "n":
			// Same shortcut as the pipeline view — open the shared
			// add-task prompt for the application currently displayed
			// in the viewer. Requires a real App# so the resulting
			// task can be linked back.
			if m.app.Number > 0 {
				m.addTask.open()
			}

		case "t":
			if m.app.Number > 0 {
				appNum := m.app.Number
				return m, func() tea.Msg {
					return ViewerOpenTasksMsg{AppNumber: appNum}
				}
			}

		case "down", "j":
			maxScroll := len(m.renderedLines) - m.bodyHeight()
			if maxScroll < 0 {
				maxScroll = 0
			}
			if m.scrollOffset < maxScroll {
				m.scrollOffset++
			}

		case "up", "k":
			if m.scrollOffset > 0 {
				m.scrollOffset--
			}

		case "pgdown", "ctrl+d":
			jump := m.bodyHeight() / 2
			maxScroll := len(m.renderedLines) - m.bodyHeight()
			if maxScroll < 0 {
				maxScroll = 0
			}
			m.scrollOffset += jump
			if m.scrollOffset > maxScroll {
				m.scrollOffset = maxScroll
			}

		case "pgup", "ctrl+u":
			jump := m.bodyHeight() / 2
			m.scrollOffset -= jump
			if m.scrollOffset < 0 {
				m.scrollOffset = 0
			}

		case "home", "g":
			m.scrollOffset = 0

		case "end", "G":
			maxScroll := len(m.renderedLines) - m.bodyHeight()
			if maxScroll < 0 {
				maxScroll = 0
			}
			m.scrollOffset = maxScroll

		case "L":
			if m.coverLetterPath != "" {
				fullPath := filepath.Join(m.careerOpsPath, filepath.FromSlash(m.coverLetterPath))
				return m, func() tea.Msg { return ViewerOpenCoverLetterMsg{Path: fullPath} }
			}
		}

	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		m.rebuildRender()

	case PipelineOpenFailedMsg:
		// Issue 3913: main.go routes this to the active screen; while the
		// viewer is open, the pipeline's flash line is not on screen.
		m.flash = "Could not open " + msg.Target + ": " + msg.Err
	}

	return m, nil
}

func (m ViewerModel) handleStatusPicker(msg tea.KeyMsg) (ViewerModel, tea.Cmd) {
	switch msg.String() {
	case "esc", "q":
		m.statusPicker = false
		m.clampScrollOffset()
		return m, nil

	case "down", "j":
		m.statusCursor++
		if m.statusCursor >= len(m.currentStatusPairs()) {
			m.statusCursor = len(m.currentStatusPairs()) - 1
		}

	case "up", "k":
		m.statusCursor--
		if m.statusCursor < 0 {
			m.statusCursor = 0
		}

	case "enter":
		m.statusPicker = false
		m.clampScrollOffset()
		newStatus := m.currentStatusPairs()[m.statusCursor].Canonical
		app := m.app
		return m, func() tea.Msg {
			return ViewerUpdateStatusMsg{
				App:       app,
				NewStatus: newStatus,
			}
		}

	default:
		key := strings.ToLower(msg.String())
		if len(key) == 1 {
			for i, pair := range m.currentStatusPairs() {
				if pair.Shortcut == key {
					m.statusCursor = i
					m.statusPicker = false
					m.clampScrollOffset()
					newStatus := pair.Canonical
					app := m.app
					return m, func() tea.Msg {
						return ViewerUpdateStatusMsg{
							App:       app,
							NewStatus: newStatus,
						}
					}
				}
			}
		}
	}
	return m, nil
}

// handleAddTaskInput routes a key into the shared add-task prompt. On submit
// (Enter at stage 2), resolves the offset and emits PipelineAddTaskMsg —
// same message the pipeline view uses so main.go has one handler for both
// entry points.
func (m ViewerModel) handleAddTaskInput(msg tea.KeyMsg) (ViewerModel, tea.Cmd) {
	if !m.addTask.handleKey(msg) {
		return m, nil
	}
	app := m.app
	title := m.addTask.Title()
	due := m.addTask.ResolvedDue()
	m.addTask.close()
	return m, func() tea.Msg {
		return PipelineAddTaskMsg{App: app, Title: title, Due: due}
	}
}

// overlayAddTaskPrompt delegates to the shared renderer with the viewer's
// application as the target label.
func (m ViewerModel) overlayAddTaskPrompt(body string) string {
	target := fmt.Sprintf("#%d %s", m.app.Number, m.app.Company)
	if m.app.Number == 0 {
		target = m.app.Company
	}
	return m.addTask.render(body, m.theme, target)
}

func (m ViewerModel) bodyHeight() int {
	h := m.height - 4 // header + footer + padding
	if m.statusPicker {
		h -= (len(m.currentStatusPairs()) + 1)
	}
	if h < 3 {
		h = 3
	}
	return h
}

func (m ViewerModel) View() string {
	header := m.renderHeader()
	body := m.renderBody()
	if m.statusPicker {
		body = m.overlayStatusPicker(body)
	}
	footer := m.renderFooter()

	view := lipgloss.JoinVertical(lipgloss.Left, header, body, footer)
	if m.addTask.active() {
		view = m.overlayAddTaskPrompt(view)
	}
	return view
}

func (m ViewerModel) overlayStatusPicker(body string) string {
	bodyLines := strings.Split(body, "\n")

	pickerWidth := 30
	padStyle := lipgloss.NewStyle().Padding(0, 2)
	borderStyle := lipgloss.NewStyle().
		Foreground(m.theme.Blue).
		Bold(true)

	var picker []string
	picker = append(picker, padStyle.Render(borderStyle.Render(i18n.Current.PickerChangeStatus)))

	for i, pair := range m.currentStatusPairs() {
		style := lipgloss.NewStyle().Foreground(m.theme.Text).Width(pickerWidth)
		if i == m.statusCursor {
			style = style.Background(m.theme.Overlay).Bold(true)
		}
		prefix := "  "
		if i == m.statusCursor {
			prefix = "> "
		}
		label := fmt.Sprintf("%s (%s)", pair.Display, strings.ToUpper(pair.Shortcut))
		picker = append(picker, padStyle.Render(style.Render(prefix+label)))
	}

	bodyLines = append(bodyLines, picker...)
	return strings.Join(bodyLines, "\n")
}

func (m ViewerModel) renderHeader() string {
	style := lipgloss.NewStyle().
		Bold(true).
		Foreground(m.theme.Text).
		Background(m.theme.Surface).
		Padding(0, 2)

	title := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Blue).Render(m.title)

	// Prefix the header with the application ID (the tracker #) so the user can
	// always see which application this report belongs to. Only shown when the
	// viewer is backed by a real application row.
	left := title
	if m.app.Number > 0 {
		idBadge := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Mauve).
			Render(fmt.Sprintf("#%d", m.app.Number))
		left = idBadge + "  " + title
	}

	right := lipgloss.NewStyle().Foreground(m.theme.Subtext)
	scroll := right.Render(func() string {
		if len(m.renderedLines) == 0 {
			return ""
		}
		pct := 0
		maxScroll := len(m.renderedLines) - m.bodyHeight()
		if maxScroll > 0 {
			pct = m.scrollOffset * 100 / maxScroll
		}
		if m.scrollOffset == 0 {
			return "Top"
		}
		if m.scrollOffset >= maxScroll {
			return "End"
		}
		return func() string {
			s := pct
			return string(rune('0'+s/10%10)) + string(rune('0'+s%10)) + "%"
		}()
	}())

	return oneLine(m.width, style, fitTitleBar(m.width, left, scroll))
}

func (m ViewerModel) renderBody() string {
	bh := m.bodyHeight()
	padStyle := lipgloss.NewStyle().Padding(0, 2)

	if len(m.renderedLines) == 0 {
		emptyStyle := lipgloss.NewStyle().Foreground(m.theme.Subtext)
		return padStyle.Render(emptyStyle.Render("(empty file)"))
	}

	end := m.scrollOffset + bh
	if end > len(m.renderedLines) {
		end = len(m.renderedLines)
	}
	visible := m.renderedLines[m.scrollOffset:end]

	flat := make([]string, bh)
	copy(flat, visible)

	return padStyle.Render(strings.Join(flat, "\n"))
}

// renderAll converts every raw markdown line into visual terminal lines.
func (m ViewerModel) renderAll() []string {
	var styled []string
	i := 0
	for i < len(m.lines) {
		line := m.lines[i]
		trimmed := strings.TrimSpace(line)

		if trimmed == "" {
			styled = append(styled, "")
			i++
			continue
		}

		if isTableLine(line) {
			tableStart := i
			for i < len(m.lines) && isTableLine(m.lines[i]) {
				i++
			}
			styled = append(styled, m.renderTableBlock(m.lines[tableStart:i])...)
			continue
		}

		if strings.HasPrefix(trimmed, "```") {
			i++
			var codeLines []string
			for i < len(m.lines) {
				if strings.TrimSpace(m.lines[i]) == "```" {
					i++
					break
				}
				codeLines = append(codeLines, m.lines[i])
				i++
			}
			codeStyle := lipgloss.NewStyle().Background(m.theme.Surface).Foreground(m.theme.Text)
			w := m.width - 6
			if w < 10 {
				w = 10
			}
			for _, cl := range codeLines {
				for _, wl := range strings.Split(ansi.Wrap("  "+cl, w, ""), "\n") {
					styled = append(styled, codeStyle.Render(wl))
				}
			}
			continue
		}

		if isSpecialBlockLine(trimmed) {
			styled = append(styled, m.styleLine(line))
			i++
			continue
		}

		start := i
		for i < len(m.lines) {
			next := strings.TrimSpace(m.lines[i])
			if next == "" || isSpecialBlockLine(next) {
				break
			}
			i++
		}
		if i > start {
			paraLines := m.lines[start:i]
			para := strings.Join(paraLines, " ")
			w := m.width - 6
			if w < 10 {
				w = 10
			}
			wrapped := m.wrapParagraph(m.renderInlineElements(para), w)
			for _, wl := range wrapped {
				styled = append(styled, wl)
			}
		}
	}

	var flat []string
	for _, s := range styled {
		if strings.IndexByte(s, '\n') >= 0 {
			flat = append(flat, strings.Split(s, "\n")...)
		} else {
			flat = append(flat, s)
		}
	}
	return balanceHyperlinks(flat)
}

func isTableLine(line string) bool {
	trimmed := strings.TrimSpace(line)
	return len(trimmed) > 1 && trimmed[0] == '|'
}

// isTableSeparator checks if a line is a table separator (|---|---|).
func isTableSeparator(line string) bool {
	trimmed := strings.TrimSpace(line)
	if !strings.HasPrefix(trimmed, "|") {
		return false
	}
	cleaned := strings.NewReplacer("|", "", "-", "", ":", "", " ", "").Replace(trimmed)
	return cleaned == ""
}

// parseTableCells splits a table line into trimmed cells.
func parseTableCells(line string) []string {
	trimmed := strings.TrimSpace(line)
	// Remove leading and trailing pipes
	if len(trimmed) > 0 && trimmed[0] == '|' {
		trimmed = trimmed[1:]
	}
	if len(trimmed) > 0 && trimmed[len(trimmed)-1] == '|' {
		trimmed = trimmed[:len(trimmed)-1]
	}
	parts := strings.Split(trimmed, "|")
	cells := make([]string, len(parts))
	for i, p := range parts {
		cells[i] = strings.TrimSpace(p)
	}
	return cells
}

func detectAlignment(sep string) lipgloss.Position {
	s := strings.TrimSpace(sep)
	if strings.HasPrefix(s, ":") && strings.HasSuffix(s, ":") {
		return lipgloss.Center
	}
	if strings.HasSuffix(s, ":") {
		return lipgloss.Right
	}
	return lipgloss.Left
}

func (m ViewerModel) renderTableBlock(lines []string) []string {
	if len(lines) == 0 {
		return nil
	}

	var headers []string
	var dataRows [][]string
	var alignments []lipgloss.Position

	for _, line := range lines {
		if isTableSeparator(line) {
			if len(alignments) == 0 {
				for _, cell := range parseTableCells(line) {
					alignments = append(alignments, detectAlignment(cell))
				}
			}
			continue
		}
		cells := parseTableCells(line)
		rendered := make([]string, len(cells))
		for i, c := range cells {
			rendered[i] = m.renderInlineElements(c)
		}
		if headers == nil {
			headers = rendered
		} else {
			dataRows = append(dataRows, rendered)
		}
	}

	if len(headers) == 0 {
		var result []string
		for _, line := range lines {
			result = append(result, m.styleLine(line))
		}
		return result
	}

	w := m.width - 6
	if w < 10 {
		w = 10
	}

	borderStyle := lipgloss.NewStyle().Foreground(m.theme.Overlay)
	t := table.New().
		Width(w).
		Wrap(true).
		BorderStyle(borderStyle).
		BorderTop(true).BorderBottom(true).
		BorderLeft(true).BorderRight(true).
		BorderHeader(true).BorderColumn(true)

	t.Headers(headers...)
	if len(dataRows) > 0 {
		t.Rows(dataRows...)
	}

	t.StyleFunc(func(row, col int) lipgloss.Style {
		st := lipgloss.NewStyle().Padding(0, 1)
		if row == table.HeaderRow {
			return st.Bold(true).Foreground(m.theme.Sky)
		}
		if col < len(alignments) {
			st = st.Align(alignments[col])
		}
		return st.Foreground(m.theme.Text)
	})

	return strings.Split(t.String(), "\n")
}

var (
	reBold           = regexp.MustCompile(`\*\*([^*]+)\*\*`)
	reLink           = regexp.MustCompile(`\[([^\]]+)\]\(((?:[^()]|\([^()]*\))+)\)`) // one level of balanced parens in the destination, as CommonMark allows
	reBareURL        = regexp.MustCompile(`https?://\S*[^\s\)\]\.,;:!?]`)
	reInlineCode     = regexp.MustCompile("`([^`]+)`")
	reListNumber     = regexp.MustCompile(`^(\s*\d+\.\s+)(.*)$`)
	reCoverLetterPDF = regexp.MustCompile(`PDF generated:\s*(output/[^\s]+\.pdf)`)
	reReportURLLine  = regexp.MustCompile(`^\*\*URL:\*\*\s*(\S+)`)
	reRelPDFPath     = regexp.MustCompile(`output/cv-[^\s\)\]\.,;:!?"']+\.pdf`)
)

func isHeadingLine(line string) bool {
	return strings.HasPrefix(line, "# ") ||
		strings.HasPrefix(line, "## ") ||
		strings.HasPrefix(line, "### ") ||
		strings.HasPrefix(line, "#### ") ||
		strings.HasPrefix(line, "##### ") ||
		strings.HasPrefix(line, "###### ")
}

func isSpecialBlockLine(line string) bool {
	trimmed := strings.TrimSpace(line)
	return isHeadingLine(trimmed) ||
		trimmed == "---" || trimmed == "***" ||
		strings.HasPrefix(trimmed, "> ") ||
		strings.HasPrefix(trimmed, "|") ||
		strings.HasPrefix(trimmed, "```") ||
		strings.HasPrefix(trimmed, "- ") ||
		strings.HasPrefix(trimmed, "* ") ||
		reListNumber.MatchString(trimmed) ||
		(strings.HasPrefix(trimmed, "**") && strings.Contains(trimmed, ":**"))
}

func (m ViewerModel) wrapParagraph(text string, width int) []string {
	if width <= 0 {
		return []string{text}
	}
	wrapped := ansi.Wrap(text, width, "")
	return strings.Split(wrapped, "\n")
}

func (m ViewerModel) renderInlineElements(line string) string {
	return m.renderInlineElementsAs(line, m.theme.Subtext)
}

// renderInlineElementsAs walks the raw line once and reapplies baseColor around
// every plain-text span, so resets emitted by inline tokens (code, bold, link,
// bare URL) don't leak through to subsequent text.
func (m ViewerModel) renderInlineElementsAs(line string, baseColor lipgloss.Color) string {
	baseStyle := lipgloss.NewStyle().Foreground(baseColor)
	codeStyle := lipgloss.NewStyle().Background(m.theme.Surface).Foreground(m.theme.Text)
	boldStyle := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Yellow)
	linkStyle := lipgloss.NewStyle().Foreground(m.theme.Blue)

	var b strings.Builder
	rest := line
	for rest != "" {
		match := findInlineMatch(rest, codeStyle, boldStyle, linkStyle, m.careerOpsPath)
		if match == nil {
			b.WriteString(baseStyle.Render(rest))
			break
		}
		if match.start > 0 {
			b.WriteString(baseStyle.Render(rest[:match.start]))
		}
		b.WriteString(match.rendered)
		rest = rest[match.end:]
	}
	return b.String()
}

type inlineMatch struct {
	start, end int
	rendered   string
}

func findInlineMatch(s string, codeStyle, boldStyle, linkStyle lipgloss.Style, careerOpsPath string) *inlineMatch {
	var best *inlineMatch
	consider := func(loc []int, rendered func() string) {
		if loc == nil || (best != nil && loc[0] >= best.start) {
			return
		}
		best = &inlineMatch{start: loc[0], end: loc[1], rendered: rendered()}
	}

	if loc := reInlineCode.FindStringIndex(s); loc != nil {
		consider(loc, func() string { return codeStyle.Render(s[loc[0]+1 : loc[1]-1]) })
	}
	if loc := reBold.FindStringIndex(s); loc != nil {
		consider(loc, func() string { return boldStyle.Render(s[loc[0]+2 : loc[1]-2]) })
	}
	if loc := reLink.FindStringIndex(s); loc != nil {
		consider(loc, func() string {
			sm := reLink.FindStringSubmatch(s[loc[0]:loc[1]])
			if len(sm) >= 3 {
				return webHyperlink(markdownLinkTarget(sm[2]), linkStyle.Render(sm[1]))
			}
			return s[loc[0]:loc[1]]
		})
	}
	if loc := reBareURL.FindStringIndex(s); loc != nil {
		consider(loc, func() string {
			bare := s[loc[0]:loc[1]]
			return webHyperlink(bare, linkStyle.Render(bare))
		})
	}
	if loc := reRelPDFPath.FindStringIndex(s); loc != nil {
		consider(loc, func() string {
			relPath := s[loc[0]:loc[1]]
			styled := linkStyle.Render(relPath)
			if careerOpsPath == "" {
				return styled
			}
			joined := filepath.Join(careerOpsPath, filepath.FromSlash(relPath))
			absPath, err := filepath.Abs(joined)
			if err != nil {
				return styled
			}
			forward := filepath.ToSlash(absPath)
			if !strings.HasPrefix(forward, "/") {
				forward = "/" + forward // Windows: C:/... → /C:/...
			}
			return hyperlink("file://"+forward, styled)
		})
	}
	return best
}

// OSC 8 hyperlinks: ESC ] 8 ; params ; URI BEL text ESC ] 8 ; ; BEL.
// Terminals that support them (iTerm2, WezTerm, kitty, VS Code, Windows
// Terminal, recent GNOME Terminal) make the text clickable; others ignore the
// sequence and show the text as before.
const osc8Close = "\x1b]8;;\x07"

const upperHex = "0123456789ABCDEF"

// reOSC8 matches one OSC 8 sequence, terminated by BEL or ST (pipeline.go's
// manifesto link uses ST). Group 2 is the URI; an empty URI closes the link.
var reOSC8 = regexp.MustCompile("\x1b\\]8;([^;\x07\x1b]*);([^\x07\x1b]*)(?:\x07|\x1b\\\\)")

// hyperlink wraps already-styled text in an OSC 8 hyperlink to target. When
// the target cannot be carried safely it returns styled unchanged, so the text
// still renders, just not as a link.
func hyperlink(target, styled string) string {
	uri, ok := osc8URI(target)
	if !ok {
		return styled
	}
	return "\x1b]8;;" + uri + "\x07" + styled + osc8Close
}

// webHyperlink links styled to rawURL only when rawURL is an absolute http(s)
// URL. Report text is derived from job postings, which are untrusted input, so
// a markdown link to javascript:, file:, data: or a relative path stays plain.
func webHyperlink(rawURL, styled string) string {
	u, err := url.Parse(rawURL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return styled
	}
	return hyperlink(rawURL, styled)
}

// markdownLinkTarget extracts the destination from a markdown link's (...)
// part, dropping an optional title (`[x](https://a "Title")`) and the angle
// brackets of `[x](<https://a>)`.
func markdownLinkTarget(dest string) string {
	dest = strings.TrimSpace(dest)
	if strings.HasPrefix(dest, "<") {
		if end := strings.IndexByte(dest, '>'); end > 0 {
			return dest[1:end]
		}
	}
	if fields := strings.Fields(dest); len(fields) > 0 {
		return fields[0]
	}
	return ""
}

// osc8URI makes target safe to embed in an OSC 8 sequence. Any control
// character (C0, DEL, C1) rejects the target outright: ESC or BEL would end
// the sequence early and let the rest of the URL reach the terminal as
// commands (see sanitizeFlash, #4027). The OSC 8 spec limits URIs to bytes
// 32-126, so spaces and non-ASCII bytes are percent-encoded rather than
// dropped, which keeps file:// links to paths like "My Drive" working.
func osc8URI(target string) (string, bool) {
	if target == "" || !utf8.ValidString(target) {
		return "", false
	}
	var b strings.Builder
	for _, r := range target {
		switch {
		case r < 0x20, r == 0x7f, r >= 0x80 && r <= 0x9f:
			return "", false
		case r == ' ' || r > 0x7e:
			for _, c := range []byte(string(r)) {
				b.WriteByte('%')
				b.WriteByte(upperHex[c>>4])
				b.WriteByte(upperHex[c&0x0f])
			}
		default:
			b.WriteRune(r)
		}
	}
	return b.String(), true
}

// balanceHyperlinks makes every rendered line carry its own complete OSC 8
// hyperlinks. ansi.Wrap keeps a link's opening and closing sequences where
// they were, so a URL wrapped over three lines opens on the first and closes
// on the last. The viewer draws and scrolls lines independently, so when the
// first line is scrolled off the rest is not clickable, and when the last is
// off the link never closes and the footer becomes part of it. This closes an
// open link at the end of each line and reopens it at the start of the next.
// Lines that are already balanced (lipgloss tables do this) are unchanged.
func balanceHyperlinks(lines []string) []string {
	out := make([]string, len(lines))
	open := "" // opening sequence of the link still active at end of line
	for i, line := range lines {
		carried := open
		for _, sm := range reOSC8.FindAllStringSubmatch(line, -1) {
			if sm[2] == "" {
				open = ""
			} else {
				open = sm[0]
			}
		}
		if carried != "" {
			line = carried + line
		}
		if open != "" {
			line += osc8Close
		}
		out[i] = line
	}
	return out
}

func (m ViewerModel) styleLine(line string) string {
	trimmed := strings.TrimSpace(line)
	w := m.width - 6
	if w < 10 {
		w = 10
	}

	if strings.HasPrefix(trimmed, "# ") && !strings.HasPrefix(trimmed, "## ") {
		content := strings.TrimPrefix(trimmed, "# ")
		return lipgloss.NewStyle().Bold(true).Foreground(m.theme.Blue).Width(w).Render("  " + content)
	}
	if strings.HasPrefix(trimmed, "## ") && !strings.HasPrefix(trimmed, "### ") {
		content := strings.TrimPrefix(trimmed, "## ")
		return lipgloss.NewStyle().Bold(true).Foreground(m.theme.Mauve).Width(w).Render("  " + content)
	}
	if strings.HasPrefix(trimmed, "### ") && !strings.HasPrefix(trimmed, "#### ") {
		content := strings.TrimPrefix(trimmed, "### ")
		return lipgloss.NewStyle().Bold(true).Foreground(m.theme.Sky).Width(w).Render("  " + content)
	}
	if strings.HasPrefix(trimmed, "#### ") && !strings.HasPrefix(trimmed, "##### ") {
		content := strings.TrimPrefix(trimmed, "#### ")
		return lipgloss.NewStyle().Bold(true).Foreground(m.theme.Subtext).Width(w).Render("    " + content)
	}
	if strings.HasPrefix(trimmed, "##### ") && !strings.HasPrefix(trimmed, "###### ") {
		content := strings.TrimPrefix(trimmed, "##### ")
		return lipgloss.NewStyle().Bold(true).Foreground(m.theme.Overlay).Width(w).Render("      " + content)
	}
	if strings.HasPrefix(trimmed, "###### ") {
		content := strings.TrimPrefix(trimmed, "###### ")
		return lipgloss.NewStyle().Bold(true).Foreground(m.theme.Overlay).Width(w).Render("        " + content)
	}
	if trimmed == "---" || trimmed == "***" {
		return lipgloss.NewStyle().Foreground(m.theme.Overlay).Width(w).Render(strings.Repeat("─", w))
	}
	if strings.HasPrefix(trimmed, "> ") {
		content := strings.TrimPrefix(trimmed, "> ")
		border := lipgloss.NewStyle().Foreground(m.theme.Overlay).Render("▎ ")
		textStyle := lipgloss.NewStyle().Foreground(m.theme.Subtext).Italic(true)
		wrapped := strings.Split(ansi.Wrap(textStyle.Render(content), w-2, ""), "\n")
		result := make([]string, 0, len(wrapped))
		for i, line := range wrapped {
			if i == 0 {
				result = append(result, border+line)
			} else {
				result = append(result, strings.Repeat(" ", ansi.StringWidth(border))+line)
			}
		}
		return strings.Join(result, "\n")
	}
	if strings.HasPrefix(trimmed, "**") && strings.Contains(trimmed, ":**") {
		styled := m.renderInlineElements(line)
		return ansi.Wrap(styled, w, "")
	}
	if strings.HasPrefix(trimmed, "- ") || strings.HasPrefix(trimmed, "* ") {
		content := trimmed[2:]
		marker := lipgloss.NewStyle().Foreground(m.theme.Blue).Render("• ")
		return m.renderListItem(marker, content, w)
	}
	if reListNumber.MatchString(trimmed) {
		sm := reListNumber.FindStringSubmatch(trimmed)
		if len(sm) >= 3 {
			marker := lipgloss.NewStyle().Foreground(m.theme.Blue).Render(sm[1])
			return m.renderListItem(marker, sm[2], w)
		}
	}

	styled := m.renderInlineElementsAs(trimmed, m.theme.Subtext)
	return ansi.Wrap(styled, w, "")
}

func (m ViewerModel) renderListItem(marker, content string, width int) string {
	markerWidth := ansi.StringWidth(marker)
	textWidth := width - markerWidth
	if textWidth < 10 {
		textWidth = 10
	}
	styled := m.renderInlineElementsAs(content, m.theme.Text)
	lines := strings.Split(ansi.Wrap(styled, textWidth, ""), "\n")
	result := make([]string, 0, len(lines))
	for i, line := range lines {
		if i == 0 {
			result = append(result, marker+line)
		} else {
			result = append(result, strings.Repeat(" ", markerWidth)+line)
		}
	}
	return strings.Join(result, "\n")
}

func (m ViewerModel) renderFooter() string {
	style := lipgloss.NewStyle().
		Foreground(m.theme.Subtext).
		Background(m.theme.Surface).
		Padding(0, 1)

	budget := m.width - 2
	if budget < 1 {
		budget = 1
	}

	// A pending flash (a clipboard-copy result, a failed status write, a
	// missing URL) takes over the footer until the next keystroke clears it.
	// Copy results keep their success/failure colours; everything else is the
	// pipeline's yellow notice.
	if m.flash != "" {
		flashColor := m.theme.Yellow
		switch {
		case strings.HasPrefix(m.flash, "Copy failed"):
			flashColor = m.theme.Red
		case strings.HasPrefix(m.flash, "Copied"):
			flashColor = m.theme.Green
		}
		return oneLine(m.width, style.Foreground(flashColor), fitPlain(budget, sanitizeFlash(m.flash)))
	}

	keyStyle := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Text)
	descStyle := lipgloss.NewStyle().Foreground(m.theme.Subtext)
	piece := func(key, desc string, pin bool) helpPiece {
		return helpPiece{text: keyStyle.Render(key) + descStyle.Render(desc), pin: pin}
	}

	// While the add-task prompt is open, hide the navigation hints and
	// show input-mode hints instead so the user knows what's reachable.
	if m.addTask.active() {
		return oneLine(m.width, style, joinHelp(budget, []helpPiece{
			piece("type", " input  ", false),
			piece("↑↓", " ±day  ", false),
			piece("Enter", " next/save  ", false),
			piece("Esc", " cancel", true),
		}, "", ""))
	}

	// While the status picker is open, the scroll hints below don't apply.
	if m.statusPicker {
		return oneLine(m.width, style, joinHelp(budget, []helpPiece{
			piece("↑/↓/j/k", i18n.Current.HelpNav, false),
			piece("Enter", i18n.Current.HelpConfirm, false),
			piece("Esc/q", i18n.Current.HelpCancel, true),
		}, "", ""))
	}

	// `t` opens the tasks screen, not a language switch — language is resolved
	// once at startup from --lang/$LANG (see main.go).
	pieces := []helpPiece{
		piece("↑↓", i18n.Current.HelpScroll, false),
		piece("PgUp/Dn", i18n.Current.HelpPage, false),
		piece("g/G", i18n.Current.HelpTopEnd, false),
	}
	if m.hasApp {
		pieces = append(pieces, piece("c", i18n.Current.HelpChange, false))
	}
	if hint := m.openURLHint(keyStyle, descStyle); hint != "" {
		pieces = append(pieces, helpPiece{text: hint})
	}
	if m.app.Number > 0 {
		pieces = append(pieces,
			piece("n", " new task  ", false),
			piece("t", " tasks  ", false),
		)
	}
	if m.coverLetterPath != "" {
		pieces = append(pieces, piece("L", " cover letter  ", false))
	}
	pieces = append(pieces,
		piece("y", " copy  ", false),
		piece("Esc", i18n.Current.HelpBack, true),
	)

	return oneLine(m.width, style, joinHelp(budget, pieces, "", ""))
}

// openURLHint shows the `o` shortcut only when the report has a posting URL.
func (m ViewerModel) openURLHint(keyStyle, descStyle lipgloss.Style) string {
	if m.jobURL == "" {
		return ""
	}
	return keyStyle.Render("o") + descStyle.Render(i18n.Current.HelpOpenURL)
}

// wordWrap performs greedy word-wrap: pack as many whitespace-separated
// tokens as fit, then start a new line. A single word longer than width is
// kept on its own line rather than mid-word split.
func wordWrap(text string, width int) []string {
	words := strings.Fields(text)
	if len(words) == 0 {
		return []string{text}
	}
	var lines []string
	var current strings.Builder
	for _, w := range words {
		if current.Len() == 0 {
			current.WriteString(w)
			continue
		}
		runeLen := utf8.RuneCountInString(current.String()) + 1 + utf8.RuneCountInString(w)
		if runeLen <= width {
			current.WriteByte(' ')
			current.WriteString(w)
		} else {
			lines = append(lines, current.String())
			current.Reset()
			current.WriteString(w)
		}
	}
	if current.Len() > 0 {
		lines = append(lines, current.String())
	}
	return lines
}

// currentStatusPairs resolves the status-change picker options for the
// application currently open in the viewer, so the picker leads with this
// row's own status (see getStatusPairs).
func (m ViewerModel) currentStatusPairs() []StatusPair {
	return getStatusPairs(data.NormalizeStatus(m.app.Status))
}
