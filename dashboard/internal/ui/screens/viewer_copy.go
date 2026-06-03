package screens

import "strings"

// viewerCopyResultMsg is emitted after an attempt to copy the report (and any
// embedded deep-research prompt) to the system clipboard. It carries enough
// context to render an accurate flash message in the footer.
type viewerCopyResultMsg struct {
	withPrompt bool  // true when a deep-research prompt was included
	err        error // non-nil when the clipboard write failed
}

// deepPromptHeading is the section the evaluation pipeline embeds in a report
// when the score clears `deep_prompt_score_threshold`. extractDeepPrompt looks
// for this heading; keep it in sync with modes/oferta.md and batch-prompt.md.
const deepPromptHeading = "deep research prompt"

// extractDeepPrompt returns the body of the "## Deep Research Prompt" section
// of a report, or "" when the report has no such section (e.g. it scored below
// the threshold, or predates the feature). The body is returned with any single
// wrapping code fence stripped so it pastes cleanly into an external chat.
func extractDeepPrompt(raw string) string {
	lines := strings.Split(raw, "\n")
	start := -1
	for i, l := range lines {
		t := strings.TrimSpace(l)
		if strings.HasPrefix(t, "## ") &&
			strings.Contains(strings.ToLower(t), deepPromptHeading) {
			start = i + 1
			break
		}
	}
	if start == -1 {
		return ""
	}

	var body []string
	inFence := false
	for i := start; i < len(lines); i++ {
		t := strings.TrimSpace(lines[i])
		// The prompt scaffold itself uses "## "/"### " headings, so only a
		// top-level "## " heading *outside* a code fence ends the section.
		if strings.HasPrefix(t, "```") {
			inFence = !inFence
			body = append(body, lines[i])
			continue
		}
		if !inFence && strings.HasPrefix(t, "## ") {
			break
		}
		body = append(body, lines[i])
	}

	return stripCodeFence(strings.TrimSpace(strings.Join(body, "\n")))
}

// stripCodeFence removes a single pair of surrounding ``` fences, if present,
// so a prompt the model wrote inside a fenced block copies as plain text.
func stripCodeFence(s string) string {
	lines := strings.Split(s, "\n")
	if len(lines) >= 2 &&
		strings.HasPrefix(strings.TrimSpace(lines[0]), "```") &&
		strings.TrimSpace(lines[len(lines)-1]) == "```" {
		return strings.TrimSpace(strings.Join(lines[1:len(lines)-1], "\n"))
	}
	return s
}

// clipboardPayload builds the text copied to the clipboard from the viewer.
// When the report embeds a deep-research prompt, the prompt comes first (it is
// the instruction the user pastes into an external LLM) followed by the full
// evaluation as reference context. The bool reports whether a prompt was found
// so the caller can flash an accurate message.
func (m ViewerModel) clipboardPayload() (string, bool) {
	eval := strings.TrimSpace(m.rawReport)
	if m.deepPrompt != "" {
		return m.deepPrompt + "\n\n---\n\n# Evaluation Report (context)\n\n" + eval, true
	}
	return eval, false
}
