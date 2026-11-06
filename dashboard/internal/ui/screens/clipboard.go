package screens

import (
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strings"
)

// copyToClipboard writes text to the system clipboard using the platform's
// native utility. It mirrors the shell-out approach already used for opening
// URLs (see main.go) so the dashboard needs no extra Go dependency.
//
// macOS/Linux pipe the UTF-8 text straight to pbcopy/wl-copy/xclip/xsel via
// stdin, all of which handle UTF-8 natively. Windows `clip.exe` mangles UTF-8
// (it decodes stdin with the OEM code page), so we round-trip through a UTF-8
// temp file read back by PowerShell's Set-Clipboard — that preserves the
// em-dashes and accented characters reports routinely contain.
func copyToClipboard(text string) error {
	switch runtime.GOOS {
	case "windows":
		return copyWindows(text)
	case "darwin":
		return pipeToClipboard(text, exec.Command("pbcopy"))
	default:
		return copyLinux(text)
	}
}

// pipeToClipboard feeds text to a clipboard command over stdin.
func pipeToClipboard(text string, cmd *exec.Cmd) error {
	cmd.Stdin = strings.NewReader(text)
	return cmd.Run()
}

// copyLinux tries the common clipboard utilities in order, preferring Wayland's
// wl-copy, then X11's xclip and xsel. Only utilities found on PATH are tried so
// a missing tool falls through to the next instead of surfacing a spurious
// error.
func copyLinux(text string) error {
	candidates := [][]string{
		{"wl-copy"},
		{"xclip", "-selection", "clipboard"},
		{"xsel", "--clipboard", "--input"},
	}
	var firstErr error
	tried := false
	for _, c := range candidates {
		if _, err := exec.LookPath(c[0]); err != nil {
			continue
		}
		tried = true
		if err := pipeToClipboard(text, exec.Command(c[0], c[1:]...)); err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		return nil
	}
	if firstErr != nil {
		return firstErr
	}
	if !tried {
		return fmt.Errorf("no clipboard utility found (install wl-clipboard, xclip, or xsel)")
	}
	return nil
}

// copyWindows writes the text to a UTF-8 temp file and has PowerShell read it
// back into the clipboard. The temp path comes from os.CreateTemp (no quotes or
// spaces that would need escaping inside the single-quoted PowerShell string).
func copyWindows(text string) error {
	f, err := os.CreateTemp("", "career-ops-clip-*.txt")
	if err != nil {
		return err
	}
	path := f.Name()
	defer os.Remove(path)

	if _, err := f.WriteString(text); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}

	script := fmt.Sprintf(
		"Set-Clipboard -Value ([System.IO.File]::ReadAllText('%s', [System.Text.Encoding]::UTF8))",
		path,
	)
	cmd := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command", script)
	return cmd.Run()
}
