package screens

import (
	"strings"
	"testing"
)

const sampleReportWithPrompt = `# Evaluation: Acme — Staff AI Engineer

**Score:** 4.2/5

---

## A) Role Summary
Builds the platform.

## Deep Research Prompt

` + "```" + `
## Deep Research: Acme — Staff AI Engineer

### 1. AI Strategy
- What products use AI?
` + "```" + `

## Keywords extracted
ai, ml, platform
`

func TestExtractDeepPromptStripsFenceAndStopsAtNextSection(t *testing.T) {
	got := extractDeepPrompt(sampleReportWithPrompt)

	if got == "" {
		t.Fatal("expected a deep prompt to be extracted")
	}
	if strings.Contains(got, "```") {
		t.Fatalf("expected wrapping code fence to be stripped, got %q", got)
	}
	if !strings.HasPrefix(got, "## Deep Research: Acme") {
		t.Fatalf("expected prompt body to lead with the scaffold heading, got %q", got)
	}
	if strings.Contains(got, "Keywords extracted") {
		t.Fatalf("expected extraction to stop at the next ## section, got %q", got)
	}
}

func TestExtractDeepPromptAbsentSection(t *testing.T) {
	raw := "# Evaluation: BigCo — SA\n\n## A) Role Summary\nNo prompt here.\n"
	if got := extractDeepPrompt(raw); got != "" {
		t.Fatalf("expected empty string when no deep prompt section, got %q", got)
	}
}

func TestClipboardPayloadWithPrompt(t *testing.T) {
	m := ViewerModel{
		rawReport:  sampleReportWithPrompt,
		deepPrompt: extractDeepPrompt(sampleReportWithPrompt),
	}
	payload, withPrompt := m.clipboardPayload()

	if !withPrompt {
		t.Fatal("expected withPrompt=true when a deep prompt is present")
	}
	// Prompt leads, evaluation follows as context.
	promptIdx := strings.Index(payload, "## Deep Research: Acme")
	evalIdx := strings.Index(payload, "# Evaluation Report (context)")
	if promptIdx < 0 || evalIdx < 0 {
		t.Fatalf("payload missing prompt or evaluation section: %q", payload)
	}
	if promptIdx > evalIdx {
		t.Fatalf("expected the prompt to precede the evaluation context")
	}
	if !strings.Contains(payload, "## A) Role Summary") {
		t.Fatalf("expected the full evaluation in the payload, got %q", payload)
	}
}

func TestClipboardPayloadWithoutPrompt(t *testing.T) {
	raw := "# Evaluation: BigCo — SA\n\n## A) Role Summary\nNo prompt here.\n"
	m := ViewerModel{rawReport: raw, deepPrompt: extractDeepPrompt(raw)}

	payload, withPrompt := m.clipboardPayload()
	if withPrompt {
		t.Fatal("expected withPrompt=false when no deep prompt is present")
	}
	if strings.Contains(payload, "Evaluation Report (context)") {
		t.Fatalf("expected no context wrapper when copying eval alone, got %q", payload)
	}
	if payload != strings.TrimSpace(raw) {
		t.Fatalf("expected payload to be the trimmed report, got %q", payload)
	}
}
