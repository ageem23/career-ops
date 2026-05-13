package screens

import (
	"fmt"
	"sort"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"github.com/santifer/career-ops/dashboard/internal/model"
	"github.com/santifer/career-ops/dashboard/internal/theme"
)

// TasksClosedMsg is emitted when the tasks screen is dismissed back to pipeline.
type TasksClosedMsg struct{}

// TasksMarkStatusMsg requests a status update for a task.
type TasksMarkStatusMsg struct {
	Task      model.Task
	NewStatus string // "done" | "skipped"
}

// TasksAddMsg requests creation of a new manual task.
type TasksAddMsg struct {
	Title string
}

// TasksRefreshMsg requests a full tasks reload (e.g. re-run sync-tasks.mjs).
type TasksRefreshMsg struct{}

// TasksFlash is a transient banner shown above the help bar after an action.
type tasksFlash struct {
	text  string
	until time.Time
}

const (
	tasksTabPending   = "pending"
	tasksTabCompleted = "completed"
)

// TasksModel implements the follow-up tasks screen.
type TasksModel struct {
	tasks         []model.Task
	filtered      []model.Task
	cursor        int
	scrollOffset  int
	activeTab     string
	width, height int
	theme         theme.Theme

	// Input prompt for new manual task
	inputMode bool
	inputBuf  string

	flash tasksFlash
}

// NewTasksModel creates a new tasks screen.
func NewTasksModel(t theme.Theme, tasks []model.Task, width, height int) TasksModel {
	m := TasksModel{
		tasks:     tasks,
		activeTab: tasksTabPending,
		width:     width,
		height:    height,
		theme:     t,
	}
	m.applyFilter()
	return m
}

// Init implements tea.Model.
func (m TasksModel) Init() tea.Cmd { return nil }

// Resize updates dimensions.
func (m *TasksModel) Resize(width, height int) {
	m.width = width
	m.height = height
}

// WithReloadedTasks rebuilds the model with fresh tasks while preserving the
// active tab and a best-effort cursor on the same task number.
func (m TasksModel) WithReloadedTasks(tasks []model.Task) TasksModel {
	selectedNum := 0
	if m.cursor >= 0 && m.cursor < len(m.filtered) {
		selectedNum = m.filtered[m.cursor].Number
	}
	reloaded := NewTasksModel(m.theme, tasks, m.width, m.height)
	reloaded.activeTab = m.activeTab
	reloaded.flash = m.flash
	reloaded.applyFilter()
	if selectedNum > 0 {
		for i, t := range reloaded.filtered {
			if t.Number == selectedNum {
				reloaded.cursor = i
				reloaded.adjustScroll()
				return reloaded
			}
		}
	}
	if len(reloaded.filtered) == 0 {
		return reloaded
	}
	if m.cursor < len(reloaded.filtered) {
		reloaded.cursor = m.cursor
	} else {
		reloaded.cursor = len(reloaded.filtered) - 1
	}
	reloaded.adjustScroll()
	return reloaded
}

// SetFlash shows a transient status message for 3 seconds.
func (m *TasksModel) SetFlash(text string) {
	m.flash = tasksFlash{text: text, until: time.Now().Add(3 * time.Second)}
}

// Update handles input.
func (m TasksModel) Update(msg tea.Msg) (TasksModel, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyMsg:
		if m.inputMode {
			return m.handleInput(msg)
		}
		return m.handleKey(msg)
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
	}
	return m, nil
}

func (m TasksModel) handleKey(msg tea.KeyMsg) (TasksModel, tea.Cmd) {
	switch msg.String() {
	case "q", "esc":
		return m, func() tea.Msg { return TasksClosedMsg{} }
	case "tab", "f", "right", "l":
		if m.activeTab == tasksTabPending {
			m.activeTab = tasksTabCompleted
		} else {
			m.activeTab = tasksTabPending
		}
		m.cursor = 0
		m.scrollOffset = 0
		m.applyFilter()
	case "left", "h":
		if m.activeTab == tasksTabPending {
			m.activeTab = tasksTabCompleted
		} else {
			m.activeTab = tasksTabPending
		}
		m.cursor = 0
		m.scrollOffset = 0
		m.applyFilter()
	case "down", "j":
		if len(m.filtered) > 0 {
			m.cursor++
			if m.cursor >= len(m.filtered) {
				m.cursor = len(m.filtered) - 1
			}
			m.adjustScroll()
		}
	case "up", "k":
		if len(m.filtered) > 0 {
			m.cursor--
			if m.cursor < 0 {
				m.cursor = 0
			}
			m.adjustScroll()
		}
	case "g":
		m.cursor = 0
		m.scrollOffset = 0
	case "G":
		if len(m.filtered) > 0 {
			m.cursor = len(m.filtered) - 1
			m.adjustScroll()
		}
	case "pgdown", "ctrl+d":
		if len(m.filtered) > 0 {
			half := m.height / 2
			if half < 1 {
				half = 1
			}
			m.cursor += half
			if m.cursor >= len(m.filtered) {
				m.cursor = len(m.filtered) - 1
			}
			m.adjustScroll()
		}
	case "pgup", "ctrl+u":
		if len(m.filtered) > 0 {
			half := m.height / 2
			if half < 1 {
				half = 1
			}
			m.cursor -= half
			if m.cursor < 0 {
				m.cursor = 0
			}
			m.adjustScroll()
		}
	case "c":
		if t, ok := m.currentTask(); ok && t.Status == "pending" {
			task := t
			return m, func() tea.Msg {
				return TasksMarkStatusMsg{Task: task, NewStatus: "done"}
			}
		}
	case "s":
		if t, ok := m.currentTask(); ok && t.Status == "pending" {
			task := t
			return m, func() tea.Msg {
				return TasksMarkStatusMsg{Task: task, NewStatus: "skipped"}
			}
		}
	case "n":
		m.inputMode = true
		m.inputBuf = ""
	case "r":
		return m, func() tea.Msg { return TasksRefreshMsg{} }
	}
	return m, nil
}

func (m TasksModel) handleInput(msg tea.KeyMsg) (TasksModel, tea.Cmd) {
	switch msg.Type {
	case tea.KeyEscape:
		m.inputMode = false
		m.inputBuf = ""
		return m, nil
	case tea.KeyEnter:
		title := strings.TrimSpace(m.inputBuf)
		m.inputMode = false
		m.inputBuf = ""
		if title == "" {
			return m, nil
		}
		return m, func() tea.Msg { return TasksAddMsg{Title: title} }
	case tea.KeyBackspace:
		if len(m.inputBuf) > 0 {
			r := []rune(m.inputBuf)
			m.inputBuf = string(r[:len(r)-1])
		}
		return m, nil
	case tea.KeyRunes, tea.KeySpace:
		if len([]rune(m.inputBuf)) >= 200 {
			return m, nil
		}
		m.inputBuf += string(msg.Runes)
		return m, nil
	}
	return m, nil
}

func (m TasksModel) currentTask() (model.Task, bool) {
	if m.cursor < 0 || m.cursor >= len(m.filtered) {
		return model.Task{}, false
	}
	return m.filtered[m.cursor], true
}

func (m *TasksModel) applyFilter() {
	var out []model.Task
	for _, t := range m.tasks {
		switch m.activeTab {
		case tasksTabPending:
			if t.Status == "pending" {
				out = append(out, t)
			}
		case tasksTabCompleted:
			if t.Status == "done" || t.Status == "skipped" {
				out = append(out, t)
			}
		}
	}

	if m.activeTab == tasksTabPending {
		// Pending: due ascending (empty due sorts last).
		sort.SliceStable(out, func(i, j int) bool {
			di, dj := out[i].Due, out[j].Due
			if di == "" || di == "-" {
				return false
			}
			if dj == "" || dj == "-" {
				return true
			}
			return di < dj
		})
	} else {
		// Completed: most recently completed first; fall back to created date.
		sort.SliceStable(out, func(i, j int) bool {
			ci, cj := out[i].Completed, out[j].Completed
			if ci == "" || ci == "-" {
				ci = out[i].Created
			}
			if cj == "" || cj == "-" {
				cj = out[j].Created
			}
			return ci > cj
		})
	}

	m.filtered = out
}

func (m *TasksModel) adjustScroll() {
	avail := m.height - 6 // header + tabs(2) + footer + padding
	if avail < 5 {
		avail = 5
	}
	if m.cursor >= m.scrollOffset+avail-2 {
		m.scrollOffset = m.cursor - avail + 3
	}
	if m.cursor < m.scrollOffset+1 {
		m.scrollOffset = m.cursor - 1
	}
	if m.scrollOffset < 0 {
		m.scrollOffset = 0
	}
}

// View renders the tasks screen.
func (m TasksModel) View() string {
	header := m.renderHeader()
	tabs := m.renderTabs()
	body := m.renderBody()
	help := m.renderHelp()
	prompt := m.renderPrompt()
	flash := m.renderFlash()

	extraLines := 0
	if prompt != "" {
		extraLines = strings.Count(prompt, "\n") + 1
	}
	if flash != "" {
		extraLines += strings.Count(flash, "\n") + 1
	}

	bodyLines := strings.Split(body, "\n")
	if m.scrollOffset > 0 && m.scrollOffset < len(bodyLines) {
		bodyLines = bodyLines[m.scrollOffset:]
	}
	avail := m.height - 5 - extraLines // header + tabs(2) + help, minus prompt/flash
	if avail < 3 {
		avail = 3
	}
	if len(bodyLines) > avail {
		bodyLines = bodyLines[:avail]
	}
	body = strings.Join(bodyLines, "\n")

	parts := []string{header, tabs, body}
	if prompt != "" {
		parts = append(parts, prompt)
	}
	if flash != "" {
		parts = append(parts, flash)
	}
	parts = append(parts, help)

	return lipgloss.JoinVertical(lipgloss.Left, parts...)
}

func (m TasksModel) renderHeader() string {
	style := lipgloss.NewStyle().
		Bold(true).
		Foreground(m.theme.Text).
		Background(m.theme.Surface).
		Width(m.width).
		Padding(0, 2)

	title := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Sky).Render("FOLLOW-UP TASKS")

	pending, done, skipped := 0, 0, 0
	overdue := 0
	today := time.Now().Format("2006-01-02")
	for _, t := range m.tasks {
		switch t.Status {
		case "pending":
			pending++
			if t.Due != "" && t.Due != "-" && t.Due < today {
				overdue++
			}
		case "done":
			done++
		case "skipped":
			skipped++
		}
	}

	right := lipgloss.NewStyle().Foreground(m.theme.Subtext).Render(
		fmt.Sprintf("%d pending | %d overdue | %d done | %d skipped", pending, overdue, done, skipped),
	)

	gap := m.width - lipgloss.Width(title) - lipgloss.Width(right) - 4
	if gap < 1 {
		gap = 1
	}
	return style.Render(title + strings.Repeat(" ", gap) + right)
}

func (m TasksModel) renderTabs() string {
	pendingCount := 0
	doneCount := 0
	for _, t := range m.tasks {
		switch t.Status {
		case "pending":
			pendingCount++
		case "done", "skipped":
			doneCount++
		}
	}

	mkTab := func(active bool, label string, count int) (string, string) {
		text := fmt.Sprintf(" %s (%d) ", label, count)
		if active {
			s := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Blue)
			return s.Render(text), strings.Repeat("━", lipgloss.Width(text))
		}
		s := lipgloss.NewStyle().Foreground(m.theme.Subtext)
		return s.Render(text), strings.Repeat("─", lipgloss.Width(text))
	}

	pTab, pUnder := mkTab(m.activeTab == tasksTabPending, "PENDING", pendingCount)
	cTab, cUnder := mkTab(m.activeTab == tasksTabCompleted, "COMPLETED", doneCount)

	row := lipgloss.JoinHorizontal(lipgloss.Top, pTab, cTab)
	underline := lipgloss.NewStyle().Foreground(m.theme.Overlay).Render(pUnder + cUnder)

	pad := lipgloss.NewStyle().Padding(0, 1)
	return pad.Render(row) + "\n" + pad.Render(underline)
}

func (m TasksModel) renderBody() string {
	if len(m.filtered) == 0 {
		empty := lipgloss.NewStyle().Foreground(m.theme.Subtext).Padding(1, 2)
		switch m.activeTab {
		case tasksTabPending:
			return empty.Render("No pending tasks. Press 'n' to add a manual task, or 'r' to re-sync.")
		default:
			return empty.Render("No completed tasks yet.")
		}
	}

	pad := lipgloss.NewStyle().Padding(0, 2)
	var lines []string
	for i, t := range m.filtered {
		lines = append(lines, pad.Render(m.renderTaskLine(t, i == m.cursor)))
	}
	return strings.Join(lines, "\n")
}

func (m TasksModel) renderTaskLine(t model.Task, selected bool) string {
	numW := 5
	dueW := 12
	appW := 6
	companyW := 18
	typeW := 10
	statusW := 9
	titleW := m.width - numW - dueW - appW - companyW - typeW - statusW - 12
	if titleW < 10 {
		titleW = 10
	}

	dueStyle := m.dueStyle(t)
	typeStyle := lipgloss.NewStyle().Foreground(m.theme.Mauve)
	statusStyle := m.statusStyle(t.Status)

	numText := fmt.Sprintf("#%d", t.Number)
	appText := "-"
	if t.AppNumber > 0 {
		appText = fmt.Sprintf("#%d", t.AppNumber)
	}
	dueText := t.Due
	if dueText == "" {
		dueText = "-"
	}

	line := fmt.Sprintf(" %s %s %s %s %s %s %s",
		lipgloss.NewStyle().Foreground(m.theme.Blue).Bold(true).Width(numW).Render(truncateRunes(numText, numW)),
		dueStyle.Width(dueW).Render(truncateRunes(dueText, dueW)),
		lipgloss.NewStyle().Foreground(m.theme.Sky).Width(appW).Render(truncateRunes(appText, appW)),
		lipgloss.NewStyle().Foreground(m.theme.Text).Width(companyW).Render(truncateRunes(t.Company, companyW)),
		typeStyle.Width(typeW).Render(truncateRunes(t.Type, typeW)),
		statusStyle.Width(statusW).Render(truncateRunes(t.Status, statusW)),
		lipgloss.NewStyle().Foreground(m.theme.Subtext).Width(titleW).Render(truncateRunes(t.Title, titleW)),
	)

	if selected {
		sel := lipgloss.NewStyle().Background(m.theme.Overlay).Width(m.width - 4)
		return sel.Render(line)
	}
	return line
}

func (m TasksModel) dueStyle(t model.Task) lipgloss.Style {
	base := lipgloss.NewStyle()
	if t.Status != "pending" {
		return base.Foreground(m.theme.Subtext)
	}
	if t.Due == "" || t.Due == "-" {
		return base.Foreground(m.theme.Subtext)
	}
	today := time.Now().Format("2006-01-02")
	if t.Due < today {
		return base.Foreground(m.theme.Red).Bold(true)
	}
	if t.Due == today {
		return base.Foreground(m.theme.Yellow).Bold(true)
	}
	return base.Foreground(m.theme.Text)
}

func (m TasksModel) statusStyle(status string) lipgloss.Style {
	switch status {
	case "pending":
		return lipgloss.NewStyle().Foreground(m.theme.Sky)
	case "done":
		return lipgloss.NewStyle().Foreground(m.theme.Green)
	case "skipped":
		return lipgloss.NewStyle().Foreground(m.theme.Subtext)
	default:
		return lipgloss.NewStyle().Foreground(m.theme.Text)
	}
}

func (m TasksModel) renderPrompt() string {
	if !m.inputMode {
		return ""
	}
	pad := lipgloss.NewStyle().Padding(0, 2)
	label := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Blue).Render("New task title: ")
	buf := lipgloss.NewStyle().Foreground(m.theme.Text).Render(m.inputBuf)
	cursor := lipgloss.NewStyle().Foreground(m.theme.Text).Render("▌")
	hint := lipgloss.NewStyle().Foreground(m.theme.Subtext).Render("   (Enter to add, Esc to cancel)")
	return pad.Render(label + buf + cursor + hint)
}

func (m TasksModel) renderFlash() string {
	if m.flash.text == "" || time.Now().After(m.flash.until) {
		return ""
	}
	pad := lipgloss.NewStyle().Padding(0, 2)
	style := lipgloss.NewStyle().Foreground(m.theme.Green).Italic(true)
	return pad.Render(style.Render(m.flash.text))
}

func (m TasksModel) renderHelp() string {
	style := lipgloss.NewStyle().
		Foreground(m.theme.Subtext).
		Background(m.theme.Surface).
		Width(m.width).
		Padding(0, 1)

	keyStyle := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Text)
	descStyle := lipgloss.NewStyle().Foreground(m.theme.Subtext)

	brand := lipgloss.NewStyle().Foreground(m.theme.Overlay).Render("career-ops by santifer.io")

	if m.inputMode {
		keys := keyStyle.Render("type") + descStyle.Render(" title  ") +
			keyStyle.Render("Enter") + descStyle.Render(" save  ") +
			keyStyle.Render("Esc") + descStyle.Render(" cancel")
		gap := m.width - lipgloss.Width(keys) - lipgloss.Width(brand) - 2
		if gap < 1 {
			gap = 1
		}
		return style.Render(keys + strings.Repeat(" ", gap) + brand)
	}

	keys := keyStyle.Render("↑↓/jk") + descStyle.Render(" nav  ") +
		keyStyle.Render("Tab/←→") + descStyle.Render(" tabs  ") +
		keyStyle.Render("c") + descStyle.Render(" complete  ") +
		keyStyle.Render("s") + descStyle.Render(" skip  ") +
		keyStyle.Render("n") + descStyle.Render(" new  ") +
		keyStyle.Render("r") + descStyle.Render(" sync  ") +
		keyStyle.Render("Esc") + descStyle.Render(" back")

	gap := m.width - lipgloss.Width(keys) - lipgloss.Width(brand) - 2
	if gap < 1 {
		gap = 1
	}
	return style.Render(keys + strings.Repeat(" ", gap) + brand)
}
