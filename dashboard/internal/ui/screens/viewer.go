package screens

import (
	"fmt"
	"os"
	"regexp"
	"strings"
	"unicode/utf8"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

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

// ViewerModel implements an integrated file viewer screen.
//
// `rawLines` holds the file as read from disk; `lines` holds the word-wrapped
// version sized to the current terminal width. Long paragraphs in JD files
// regularly exceed 200 chars and were previously truncated by the terminal —
// wrapping happens at load and again on every Resize, with scrollOffset
// clamped so the user doesn't end up below the new visible end.
type ViewerModel struct {
	rawLines      []string
	lines         []string
	title         string
	scrollOffset  int
	width         int
	height        int
	theme         theme.Theme
	app           model.CareerApplication
	careerOpsPath string
	hasApp        bool
	statusPicker  bool
	statusCursor  int
	// Add-task prompt sub-state — shared helper used by both pipeline and
	// viewer so the keystroke + flow is identical between the two.
	addTask addTaskPrompt
}

// wrapMargin is reserved for the body padding (2 cols) plus a small safety
// gap so wrapped lines never touch the right edge.
const wrapMargin = 6

// NewViewerModel creates a new file viewer for the given path.
// If app.ReportPath is non-empty, the viewer enables in-place status changes.
// tasks is the list of tasks linked to this application (filtered by App#);
// the viewer renders them as a markdown table prepended to the report body so
// the user can review all open work on this application at a glance.
func NewViewerModel(t theme.Theme, path, title string, width, height int, app model.CareerApplication, careerOpsPath string, tasks []model.Task) ViewerModel {
	content, err := os.ReadFile(path)
	if err != nil {
		content = []byte("Error reading file: " + err.Error())
	}

	raw := strings.Split(string(content), "\n")
	if len(tasks) > 0 {
		raw = append(buildTasksHeader(tasks), raw...)
	}
	return ViewerModel{
		rawLines:      raw,
		lines:         wrapAll(raw, width-wrapMargin),
		title:         title,
		width:         width,
		height:        height,
		theme:         t,
		app:           app,
		careerOpsPath: careerOpsPath,
		hasApp:        app.ReportPath != "" || app.Company != "",
	}
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

func (m ViewerModel) Init() tea.Cmd {
	return nil
}

func (m *ViewerModel) Resize(width, height int) {
	m.width = width
	m.height = height
	m.lines = wrapAll(m.rawLines, width-wrapMargin)
	// After re-wrapping, the visible range may have shrunk — clamp scrollOffset
	// so we don't render off the end of the wrapped list.
	maxScroll := len(m.lines) - m.bodyHeight()
	if maxScroll < 0 {
		maxScroll = 0
	}
	if m.scrollOffset > maxScroll {
		m.scrollOffset = maxScroll
	}
}

func (m ViewerModel) Update(msg tea.Msg) (ViewerModel, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyMsg:
		if m.statusPicker {
			return m.handleStatusPicker(msg)
		}
		if m.addTask.active() {
			return m.handleAddTaskInput(msg)
		}
		switch msg.String() {
		case "q", "esc":
			return m, func() tea.Msg { return ViewerClosedMsg{} }

		case "c":
			if m.hasApp {
				m.statusPicker = true
				m.statusCursor = 0
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

		case "o":
			if m.app.JobURL != "" {
				url := m.app.JobURL
				return m, func() tea.Msg {
					return PipelineOpenURLMsg{URL: url}
				}
			}

		case "down", "j":
			maxScroll := len(m.lines) - m.bodyHeight()
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
			maxScroll := len(m.lines) - m.bodyHeight()
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
			maxScroll := len(m.lines) - m.bodyHeight()
			if maxScroll < 0 {
				maxScroll = 0
			}
			m.scrollOffset = maxScroll
		}

	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
	}

	return m, nil
}

func (m ViewerModel) handleStatusPicker(msg tea.KeyMsg) (ViewerModel, tea.Cmd) {
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
		app := m.app
		path := m.careerOpsPath
		return m, func() tea.Msg {
			return PipelineUpdateStatusMsg{
				CareerOpsPath: path,
				App:           app,
				NewStatus:     newStatus,
			}
		}

	default:
		key := strings.ToLower(msg.String())
		if len(key) == 1 {
			for i, opt := range statusOptions {
				if opt.shortcut == key {
					m.statusCursor = i
					m.statusPicker = false
					newStatus := opt.label
					app := m.app
					path := m.careerOpsPath
					return m, func() tea.Msg {
						return PipelineUpdateStatusMsg{
							CareerOpsPath: path,
							App:           app,
							NewStatus:     newStatus,
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
	if h < 3 {
		h = 3
	}
	return h
}

func (m ViewerModel) View() string {
	header := m.renderHeader()
	body := m.renderBody()
	footer := m.renderFooter()

	view := lipgloss.JoinVertical(lipgloss.Left, header, body, footer)
	if m.statusPicker {
		view = m.overlayStatusPicker(view)
	}
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
	picker = append(picker, padStyle.Render(borderStyle.Render("Change status:")))

	for i, opt := range statusOptions {
		style := lipgloss.NewStyle().Foreground(m.theme.Text).Width(pickerWidth)
		if i == m.statusCursor {
			style = style.Background(m.theme.Overlay).Bold(true)
		}
		prefix := "  "
		if i == m.statusCursor {
			prefix = "> "
		}
		label := fmt.Sprintf("%s (%s)", opt.label, strings.ToUpper(opt.shortcut))
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
		Width(m.width).
		Padding(0, 2)

	title := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Blue).Render(m.title)

	right := lipgloss.NewStyle().Foreground(m.theme.Subtext)
	pos := right.Render(strings.TrimRight(
		strings.Repeat(" ", max(0, m.width-lipgloss.Width(m.title)-30)),
		" ",
	))

	lineInfo := right.Render(
		strings.Join([]string{
			"L",
			strings.TrimSpace(lipgloss.NewStyle().Render(
				strings.Join([]string{
					func() string {
						s := m.scrollOffset + 1
						if s > len(m.lines) {
							s = len(m.lines)
						}
						return string(rune('0'+s/100%10)) + string(rune('0'+s/10%10)) + string(rune('0'+s%10))
					}(),
				}, ""),
			)),
			"/",
			func() string {
				t := len(m.lines)
				return string(rune('0'+t/100%10)) + string(rune('0'+t/10%10)) + string(rune('0'+t%10))
			}(),
		}, ""),
	)
	_ = pos
	_ = lineInfo

	scroll := right.Render(func() string {
		if len(m.lines) == 0 {
			return ""
		}
		pct := 0
		maxScroll := len(m.lines) - m.bodyHeight()
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

	gap := m.width - lipgloss.Width(m.title) - lipgloss.Width(scroll) - 4
	if gap < 1 {
		gap = 1
	}

	return style.Render(title + strings.Repeat(" ", gap) + scroll)
}

func (m ViewerModel) renderBody() string {
	bh := m.bodyHeight()
	padStyle := lipgloss.NewStyle().Padding(0, 2)

	if len(m.lines) == 0 {
		emptyStyle := lipgloss.NewStyle().Foreground(m.theme.Subtext)
		return padStyle.Render(emptyStyle.Render("(empty file)"))
	}

	end := m.scrollOffset + bh
	if end > len(m.lines) {
		end = len(m.lines)
	}
	visible := m.lines[m.scrollOffset:end]

	// Render with table block detection
	var styled []string
	i := 0
	for i < len(visible) {
		if isTableLine(visible[i]) {
			// Collect consecutive table lines
			tableStart := i
			for i < len(visible) && isTableLine(visible[i]) {
				i++
			}
			tableLines := visible[tableStart:i]

			// Also look ahead in full document for remaining table rows
			// that may be just beyond the visible window, to get correct column widths
			fullTableStart := m.scrollOffset + tableStart
			fullTableEnd := fullTableStart
			for fullTableEnd < len(m.lines) && isTableLine(m.lines[fullTableEnd]) {
				fullTableEnd++
			}
			fullTable := m.lines[fullTableStart:fullTableEnd]

			// Compute column widths from the full table, render only visible rows
			colWidths := computeColumnWidths(fullTable, m.width-6)
			rendered := m.renderTableBlock(tableLines, colWidths, fullTableStart)
			styled = append(styled, rendered...)
		} else {
			styled = append(styled, m.styleLine(visible[i]))
			i++
		}
	}

	// Pad to fill height
	for len(styled) < bh {
		styled = append(styled, "")
	}

	return padStyle.Render(strings.Join(styled, "\n"))
}

// isTableLine checks if a line is part of a markdown table.
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

// computeColumnWidths calculates max width per column across all table rows.
func computeColumnWidths(lines []string, maxTotal int) []int {
	maxCols := 0
	for _, line := range lines {
		if isTableSeparator(line) {
			continue
		}
		cells := parseTableCells(line)
		if len(cells) > maxCols {
			maxCols = len(cells)
		}
	}
	if maxCols == 0 {
		return nil
	}

	widths := make([]int, maxCols)
	for _, line := range lines {
		if isTableSeparator(line) {
			continue
		}
		cells := parseTableCells(line)
		for i, cell := range cells {
			if i < maxCols {
				w := lipgloss.Width(cell)
				if w > widths[i] {
					widths[i] = w
				}
			}
		}
	}

	// Cap individual columns based on column count
	maxColW := 45
	if maxCols > 5 {
		maxColW = 30
	}
	if maxCols > 7 {
		maxColW = 22
	}
	for i := range widths {
		if widths[i] > maxColW {
			widths[i] = maxColW
		}
		if widths[i] < 3 {
			widths[i] = 3
		}
	}

	// Shrink to fit available width
	for {
		total := 1 // trailing border
		for _, w := range widths {
			total += w + 3 // cell padding + border
		}
		if total <= maxTotal {
			break
		}
		// Find the widest column and shrink it by 1
		widestIdx := 0
		widestVal := 0
		for i, w := range widths {
			if w > widestVal {
				widestVal = w
				widestIdx = i
			}
		}
		if widths[widestIdx] <= 3 {
			break // can't shrink further
		}
		widths[widestIdx]--
	}

	return widths
}

// renderTableBlock renders table lines with aligned columns and box-drawing borders.
func (m ViewerModel) renderTableBlock(lines []string, colWidths []int, firstLineIdx int) []string {
	if len(lines) == 0 || len(colWidths) == 0 {
		// Fallback: render as plain text
		var result []string
		for _, line := range lines {
			result = append(result, m.styleLine(line))
		}
		return result
	}

	maxCols := len(colWidths)
	borderStyle := lipgloss.NewStyle().Foreground(m.theme.Overlay)
	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Sky)
	dataStyle := lipgloss.NewStyle().Foreground(m.theme.Text)

	// Build top border
	var result []string
	var topParts []string
	for _, w := range colWidths {
		topParts = append(topParts, strings.Repeat("─", w+2))
	}
	result = append(result, borderStyle.Render("┌"+strings.Join(topParts, "┬")+"┐"))

	isFirstDataRow := true
	for _, line := range lines {
		if isTableSeparator(line) {
			// Render middle separator
			var sepParts []string
			for _, w := range colWidths {
				sepParts = append(sepParts, strings.Repeat("─", w+2))
			}
			result = append(result, borderStyle.Render("├"+strings.Join(sepParts, "┼")+"┤"))
			continue
		}

		cells := parseTableCells(line)
		var paddedCells []string
		for i := 0; i < maxCols; i++ {
			cell := ""
			if i < len(cells) {
				cell = cells[i]
			}
			cellWidth := lipgloss.Width(cell)
			colW := colWidths[i]

			if cellWidth > colW {
				// Truncate — need to handle multi-byte/emoji carefully
				runes := []rune(cell)
				truncated := string(runes)
				for lipgloss.Width(truncated) > colW-3 && len(runes) > 0 {
					runes = runes[:len(runes)-1]
					truncated = string(runes)
				}
				cell = truncated + "..."
				cellWidth = lipgloss.Width(cell)
			}

			padding := colW - cellWidth
			if padding < 0 {
				padding = 0
			}
			paddedCells = append(paddedCells, " "+cell+strings.Repeat(" ", padding)+" ")
		}

		// Build row with borders
		border := borderStyle.Render("│")
		var rowParts []string
		for _, cell := range paddedCells {
			if isFirstDataRow {
				rowParts = append(rowParts, headerStyle.Render(cell))
			} else {
				rowParts = append(rowParts, dataStyle.Render(cell))
			}
		}
		row := border + strings.Join(rowParts, border) + border
		result = append(result, row)
		isFirstDataRow = false
	}

	// Bottom border
	var bottomParts []string
	for _, w := range colWidths {
		bottomParts = append(bottomParts, strings.Repeat("─", w+2))
	}
	result = append(result, borderStyle.Render("└"+strings.Join(bottomParts, "┴")+"┘"))

	return result
}

var reBold = regexp.MustCompile(`\*\*([^*]+)\*\*`)

func (m ViewerModel) styleLine(line string) string {
	trimmed := strings.TrimSpace(line)

	// H1 — render without the "# " prefix
	if strings.HasPrefix(trimmed, "# ") && !strings.HasPrefix(trimmed, "## ") {
		content := strings.TrimPrefix(trimmed, "# ")
		return lipgloss.NewStyle().
			Bold(true).
			Foreground(m.theme.Blue).
			Render("  " + content)
	}
	// H2 — render without the "## " prefix
	if strings.HasPrefix(trimmed, "## ") && !strings.HasPrefix(trimmed, "### ") {
		content := strings.TrimPrefix(trimmed, "## ")
		return lipgloss.NewStyle().
			Bold(true).
			Foreground(m.theme.Mauve).
			Render("  " + content)
	}
	// H3 — render without the "### " prefix
	if strings.HasPrefix(trimmed, "### ") {
		content := strings.TrimPrefix(trimmed, "### ")
		return lipgloss.NewStyle().
			Bold(true).
			Foreground(m.theme.Sky).
			Render("  " + content)
	}
	// Horizontal rule
	if trimmed == "---" || trimmed == "***" {
		return lipgloss.NewStyle().
			Foreground(m.theme.Overlay).
			Render(strings.Repeat("─", m.width-4))
	}
	// Blockquote
	if strings.HasPrefix(trimmed, "> ") {
		content := strings.TrimPrefix(trimmed, "> ")
		border := lipgloss.NewStyle().Foreground(m.theme.Overlay).Render("▎ ")
		text := lipgloss.NewStyle().Foreground(m.theme.Subtext).Italic(true).Render(content)
		return border + text
	}
	// Bold fields like **Score:** 4.0/5 — render with bold label, strip asterisks
	if strings.HasPrefix(trimmed, "**") && strings.Contains(trimmed, ":**") {
		return m.renderInlineBold(line, m.theme.Yellow)
	}
	// Bullet points and numbered lists
	if strings.HasPrefix(trimmed, "- ") || strings.HasPrefix(trimmed, "* ") {
		return m.renderInlineBold(line, m.theme.Text)
	}
	if len(trimmed) > 2 && trimmed[0] >= '0' && trimmed[0] <= '9' && strings.Contains(trimmed[:3], ".") {
		return m.renderInlineBold(line, m.theme.Text)
	}

	// Default — still check for inline bold
	if strings.Contains(trimmed, "**") {
		return m.renderInlineBold(line, m.theme.Subtext)
	}

	return lipgloss.NewStyle().
		Foreground(m.theme.Subtext).
		Render(line)
}

// renderInlineBold renders a line with **bold** segments highlighted.
func (m ViewerModel) renderInlineBold(line string, baseColor lipgloss.Color) string {
	baseStyle := lipgloss.NewStyle().Foreground(baseColor)
	boldStyle := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Yellow)

	matches := reBold.FindAllStringIndex(line, -1)
	if len(matches) == 0 {
		return baseStyle.Render(line)
	}

	var result strings.Builder
	last := 0
	for _, loc := range matches {
		// Render text before the bold
		if loc[0] > last {
			result.WriteString(baseStyle.Render(line[last:loc[0]]))
		}
		// Extract bold content (without **)
		boldText := line[loc[0]+2 : loc[1]-2]
		result.WriteString(boldStyle.Render(boldText))
		last = loc[1]
	}
	// Render remaining text
	if last < len(line) {
		result.WriteString(baseStyle.Render(line[last:]))
	}

	return result.String()
}

func (m ViewerModel) renderFooter() string {
	style := lipgloss.NewStyle().
		Foreground(m.theme.Subtext).
		Background(m.theme.Surface).
		Width(m.width).
		Padding(0, 1)

	keyStyle := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Text)
	descStyle := lipgloss.NewStyle().Foreground(m.theme.Subtext)

	// While the add-task prompt is open, hide the navigation hints and
	// show input-mode hints instead so the user knows what's reachable.
	if m.addTask.active() {
		return style.Render(
			keyStyle.Render("type") + descStyle.Render(" input  ") +
				keyStyle.Render("↑↓") + descStyle.Render(" ±day  ") +
				keyStyle.Render("Enter") + descStyle.Render(" next/save  ") +
				keyStyle.Render("Esc") + descStyle.Render(" cancel"))
	}

	parts := keyStyle.Render("↑↓") + descStyle.Render(" scroll  ") +
		keyStyle.Render("PgUp/Dn") + descStyle.Render(" page  ") +
		keyStyle.Render("g/G") + descStyle.Render(" top/end  ")
	if m.hasApp {
		parts += keyStyle.Render("c") + descStyle.Render(" change status  ")
	}
	if m.app.JobURL != "" {
		parts += keyStyle.Render("o") + descStyle.Render(" open URL  ")
	}
	if m.app.Number > 0 {
		parts += keyStyle.Render("n") + descStyle.Render(" new task  ") +
			keyStyle.Render("t") + descStyle.Render(" tasks  ")
	}
	parts += keyStyle.Render("Esc") + descStyle.Render(" back")
	return style.Render(parts)
}

// ── Word wrapping ───────────────────────────────────────────────────
//
// Long paragraphs (e.g. JD body text scraped from LinkedIn) used to render
// truncated at the terminal edge. We pre-wrap once at load and again on
// every Resize so scroll math stays in display-line space and the user can
// always read the full content.

// wrapAll wraps every line in raw to the given width, preserving any
// markdown prefix (heading, bullet, blockquote) on the first sub-line and
// indenting continuation lines appropriately. Returns a flat list of
// display lines suitable for direct rendering.
func wrapAll(raw []string, width int) []string {
	if width <= 10 {
		// Too narrow to wrap usefully — fall back to raw to avoid mangled output.
		out := make([]string, len(raw))
		copy(out, raw)
		return out
	}
	out := make([]string, 0, len(raw))
	for _, line := range raw {
		out = append(out, wrapLine(line, width)...)
	}
	return out
}

// wrapLine wraps a single source line to width, preserving markdown prefix
// structure. Tables, horizontal rules, and short-enough lines pass through
// unchanged.
func wrapLine(line string, width int) []string {
	if utf8.RuneCountInString(line) <= width {
		return []string{line}
	}
	trimmed := strings.TrimSpace(line)
	// Pass-through cases: tables (handled by renderTableBlock), horizontal
	// rules, and empty lines.
	if trimmed == "" || strings.HasPrefix(trimmed, "|") || trimmed == "---" || trimmed == "***" {
		return []string{line}
	}

	// Determine prefix (kept on first sub-line) and continuation indent
	// (used on every subsequent sub-line). Headings get no continuation —
	// the leading marker is part of the headline, not the prose.
	var prefix, continuation, body string
	switch {
	case strings.HasPrefix(trimmed, "### "):
		prefix = "### "
		continuation = "    "
		body = strings.TrimPrefix(trimmed, "### ")
	case strings.HasPrefix(trimmed, "## "):
		prefix = "## "
		continuation = "   "
		body = strings.TrimPrefix(trimmed, "## ")
	case strings.HasPrefix(trimmed, "# "):
		prefix = "# "
		continuation = "  "
		body = strings.TrimPrefix(trimmed, "# ")
	case strings.HasPrefix(trimmed, "> "):
		prefix = "> "
		continuation = "> "
		body = strings.TrimPrefix(trimmed, "> ")
	case strings.HasPrefix(trimmed, "- "):
		prefix = "- "
		continuation = "  "
		body = strings.TrimPrefix(trimmed, "- ")
	case strings.HasPrefix(trimmed, "* "):
		prefix = "* "
		continuation = "  "
		body = strings.TrimPrefix(trimmed, "* ")
	default:
		body = trimmed
	}

	bodyWidth := width - utf8.RuneCountInString(prefix)
	if bodyWidth < 10 {
		return []string{line}
	}
	wrapped := wordWrap(body, bodyWidth)
	if len(wrapped) <= 1 {
		return []string{line}
	}

	result := make([]string, len(wrapped))
	for i, w := range wrapped {
		if i == 0 {
			result[i] = prefix + w
		} else {
			result[i] = continuation + w
		}
	}
	return result
}

// wordWrap performs greedy word-wrap: pack as many whitespace-separated
// tokens as fit, then start a new line. A single word longer than width is
// kept on its own line rather than mid-word split (terminal will truncate
// at the right edge if it's truly that long, but that's rare).
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
