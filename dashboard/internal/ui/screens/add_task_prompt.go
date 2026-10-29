package screens

import (
	"fmt"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"github.com/santifer/career-ops/dashboard/internal/theme"
)

// Shared bounds for the add-task prompt used by both pipeline and viewer.
const (
	// addTaskDueMax bounds the days-from-today value at roughly ten years
	// out so a stuck arrow key or a fat-fingered "9999999" can't produce a
	// nonsense date. Well past anything a reasonable task needs.
	addTaskDueMax = 4000
	// addTaskTitleMaxRunes caps the manual-task title at a length that
	// still fits in the dashboard table column and the markdown row
	// without truncation hurting readability.
	addTaskTitleMaxRunes = 200
)

// addTaskPrompt is the two-stage "add task for this application" sub-state
// used by both the pipeline view and the report viewer. Owning the input
// model + render in one place keeps the two entry points byte-for-byte
// consistent — same keys, same hints, same validation, same display format.
//
// Lifecycle: open() resets to stage 1 (title), handleKey advances stages on
// Enter and returns submit=true when the user completes stage 2. The caller
// then reads Title() / ResolvedDue() and calls close().
type addTaskPrompt struct {
	stage   int    // 0 closed, 1 title, 2 due
	title   string
	dueDays int    // -1 = no due, 0 = today, N = today + N days
	typed   bool   // user has typed a digit since stage 2 opened
	err     string // transient error shown below the input
}

func (p *addTaskPrompt) open() {
	p.stage = 1
	p.title = ""
	p.dueDays = 0
	p.typed = false
	p.err = ""
}

func (p *addTaskPrompt) close() {
	p.stage = 0
	p.title = ""
	p.dueDays = 0
	p.typed = false
	p.err = ""
}

// active reports whether the prompt is currently open.
func (p addTaskPrompt) active() bool { return p.stage > 0 }

// Title returns the trimmed title captured at stage 1 transition.
func (p addTaskPrompt) Title() string { return p.title }

// ResolvedDue returns the YYYY-MM-DD form of the current offset, or "" when
// the user has opted out of a due date (dueDays < 0).
func (p addTaskPrompt) ResolvedDue() string {
	if p.dueDays < 0 {
		return ""
	}
	return time.Now().AddDate(0, 0, p.dueDays).Format("2006-01-02")
}

// handleKey processes a key for the prompt. Returns submit=true when the
// user completed stage 2 with Enter; the caller should then read Title() and
// ResolvedDue() and call close().
//
// Stage 2 controls:
//   - ↑ / ↓: adjust the offset by one day (↓ from 0 = "no due date").
//   - digit keys: set the offset directly (first digit replaces, subsequent
//     digits append, so 1 then 0 makes 10).
//   - Backspace: pop a digit, or reset to 0 if already single-digit.
//   - Enter: finish — caller submits.
func (p *addTaskPrompt) handleKey(msg tea.KeyMsg) (submit bool) {
	switch msg.Type {
	case tea.KeyEscape:
		p.close()
		return false
	case tea.KeyEnter:
		if p.stage == 1 {
			title := strings.TrimSpace(p.title)
			if title == "" {
				p.err = "title cannot be empty"
				return false
			}
			p.title = title
			p.stage = 2
			p.dueDays = 0
			p.typed = false
			p.err = ""
			return false
		}
		// Stage 2 — caller resolves and submits.
		return true
	case tea.KeyUp:
		if p.stage == 2 && p.dueDays < addTaskDueMax {
			p.dueDays++
			p.typed = false
			p.err = ""
		}
	case tea.KeyDown:
		if p.stage == 2 && p.dueDays > -1 {
			p.dueDays--
			p.typed = false
			p.err = ""
		}
	case tea.KeyBackspace:
		if p.stage == 1 && len(p.title) > 0 {
			r := []rune(p.title)
			p.title = string(r[:len(r)-1])
		} else if p.stage == 2 {
			if p.dueDays >= 10 {
				p.dueDays /= 10
			} else {
				p.dueDays = 0
				p.typed = false
			}
		}
	case tea.KeyRunes, tea.KeySpace:
		if p.stage == 1 {
			if len([]rune(p.title)) >= addTaskTitleMaxRunes {
				return false
			}
			p.title += string(msg.Runes)
			return false
		}
		if p.stage == 2 {
			// Only digits make sense as direct input. Reject the rest
			// with a transient error so the user sees what's expected.
			allDigits := true
			for _, r := range msg.Runes {
				if r < '0' || r > '9' {
					allDigits = false
					break
				}
			}
			if !allDigits {
				p.err = "use digits, ↑/↓, or Enter"
				return false
			}
			for _, r := range msg.Runes {
				d := int(r - '0')
				if !p.typed || p.dueDays < 0 {
					p.dueDays = d
					p.typed = true
				} else if p.dueDays*10+d <= addTaskDueMax {
					p.dueDays = p.dueDays*10 + d
				}
			}
			p.err = ""
		}
	}
	return false
}

// formatDueDays renders the stage-2 due-date field given the current days
// offset. The resolved calendar date is shown in parentheses so the offset
// stays grounded in a real date.
func formatDueDays(days int) string {
	if days < 0 {
		return "— (no due date)"
	}
	target := time.Now().AddDate(0, 0, days).Format("2006-01-02")
	switch days {
	case 0:
		return fmt.Sprintf("today (%s)", target)
	case 1:
		return fmt.Sprintf("1 day from today (%s)", target)
	default:
		return fmt.Sprintf("%d days from today (%s)", days, target)
	}
}

// render appends the prompt's display lines to `body` and returns the new
// body. `target` is the application label shown in the header (e.g. "#412
// Acme"). Both callers feed this to whatever final assembly they do.
func (p addTaskPrompt) render(body string, t theme.Theme, target string) string {
	bodyLines := strings.Split(body, "\n")

	padStyle := lipgloss.NewStyle().Padding(0, 2)
	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(t.Blue)
	labelStyle := lipgloss.NewStyle().Bold(true).Foreground(t.Sky)
	valueStyle := lipgloss.NewStyle().Foreground(t.Text)
	dimStyle := lipgloss.NewStyle().Foreground(t.Subtext)
	errStyle := lipgloss.NewStyle().Foreground(t.Red)
	cursor := valueStyle.Render("▌")

	var prompt []string
	prompt = append(prompt, padStyle.Render(headerStyle.Render("New task — "+target)))

	if p.stage == 1 {
		line := labelStyle.Render("Title: ") + valueStyle.Render(p.title) + cursor
		prompt = append(prompt, padStyle.Render(line))
		prompt = append(prompt, padStyle.Render(dimStyle.Render("Enter: next  Esc: cancel")))
	} else {
		prompt = append(prompt, padStyle.Render(labelStyle.Render("Title: ")+valueStyle.Render(p.title)))
		dueText := formatDueDays(p.dueDays)
		line := labelStyle.Render("Due: ") + valueStyle.Render(dueText) + cursor
		prompt = append(prompt, padStyle.Render(line))
		prompt = append(prompt, padStyle.Render(dimStyle.Render("↑/↓: ±1 day · digits: set days · ↓ at 0: no due · Enter: save · Esc: cancel")))
	}
	if p.err != "" {
		prompt = append(prompt, padStyle.Render(errStyle.Render(p.err)))
	}

	bodyLines = append(bodyLines, prompt...)
	return strings.Join(bodyLines, "\n")
}
