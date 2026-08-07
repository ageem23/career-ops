package data

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/santifer/career-ops/dashboard/internal/model"
)

// PDFManifestEntry is one row of data/pdf-index.tsv, written by
// generate-pdf.mjs each time a PDF is produced. ReportNumber may be empty
// for PDFs generated without --report; those rows still help the glob
// matcher via their recorded paths.
type PDFManifestEntry struct {
	ReportNumber string
	PDFPath      string // relative to the career-ops root
	HTMLPath     string // relative to the career-ops root, "" if unknown
	Format       string // "letter" or "a4"
	Date         string // YYYY-MM-DD generation date
}

// PDFManifest indexes manifest entries by normalized report number (leading
// zeros stripped, so "008" and "8" collide deliberately). Rows without a
// report number are not indexed (the glob path covers them).
type PDFManifest map[string]PDFManifestEntry

// isSafeRepoRelativePath returns true iff p is a non-empty, non-absolute path
// with no ".." traversal components. Used to reject crafted TSV rows before
// they reach dashboard open/regenerate flows.
func isSafeRepoRelativePath(p string) bool {
	p = filepath.Clean(filepath.FromSlash(strings.TrimSpace(p)))
	if p == "." || p == "" {
		return false
	}
	if filepath.IsAbs(p) {
		return false
	}
	if p == ".." || strings.HasPrefix(p, ".."+string(filepath.Separator)) {
		return false
	}
	return true
}

// normalizeReportKey strips leading zeros so the zero-padded report-link
// form ("008") and the unpadded tracker-# form ("8") key identically.
func normalizeReportKey(s string) string {
	s = strings.TrimSpace(s)
	trimmed := strings.TrimLeft(s, "0")
	if trimmed == "" && s != "" {
		return "0"
	}
	return trimmed
}

// Lookup finds the manifest entry for an application, trying the report-link
// number first (the NNN in reports/NNN-….md) and falling back to the tracker
// # column. The two usually agree but are scrambled in real trackers, and
// callers passing --report may have used either — tolerate both.
func (m PDFManifest) Lookup(app model.CareerApplication) (PDFManifestEntry, bool) {
	if key := normalizeReportKey(app.ReportNumber); key != "" {
		if entry, ok := m[key]; ok {
			return entry, true
		}
	}
	if app.Number > 0 {
		if entry, ok := m[strconv.Itoa(app.Number)]; ok {
			return entry, true
		}
	}
	return PDFManifestEntry{}, false
}

// LoadPDFEntriesByPath reads data/pdf-index.tsv and returns all entries indexed
// by their relative PDF path. Unlike LoadPDFManifest, this includes rows that
// were generated without a --report flag. Later rows in the file win.
func LoadPDFEntriesByPath(careerOpsPath string) map[string]PDFManifestEntry {
	byPath := make(map[string]PDFManifestEntry)
	raw, err := os.ReadFile(filepath.Join(careerOpsPath, "data", "pdf-index.tsv"))
	if err != nil {
		return byPath
	}
	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimRight(line, "\r")
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		fields := strings.Split(line, "\t")
		if len(fields) < 2 {
			continue
		}
		entry := PDFManifestEntry{
			ReportNumber: strings.TrimSpace(fields[0]),
			PDFPath:      strings.TrimSpace(fields[1]),
		}
		if entry.PDFPath == "" || !isSafeRepoRelativePath(entry.PDFPath) {
			continue
		}
		if len(fields) > 2 {
			entry.HTMLPath = strings.TrimSpace(fields[2])
			if entry.HTMLPath != "" && !isSafeRepoRelativePath(entry.HTMLPath) {
				entry.HTMLPath = ""
			}
		}
		if len(fields) > 3 {
			entry.Format = strings.TrimSpace(fields[3])
		}
		if len(fields) > 4 {
			entry.Date = strings.TrimSpace(fields[4])
		}
		byPath[entry.PDFPath] = entry
	}
	return byPath
}

// LoadPDFManifest reads data/pdf-index.tsv under careerOpsPath. A missing
// file is not an error — the manifest is optional and absent until the
// first generate-pdf.mjs run that writes it. Later rows win over earlier
// ones for the same report number, so regenerated PDFs supersede stale
// entries without any compaction step.
func LoadPDFManifest(careerOpsPath string) PDFManifest {
	manifest := make(PDFManifest)
	raw, err := os.ReadFile(filepath.Join(careerOpsPath, "data", "pdf-index.tsv"))
	if err != nil {
		return manifest
	}

	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimRight(line, "\r")
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		fields := strings.Split(line, "\t")
		if len(fields) < 2 {
			continue
		}
		entry := PDFManifestEntry{
			ReportNumber: strings.TrimSpace(fields[0]),
			PDFPath:      strings.TrimSpace(fields[1]),
		}
		if len(fields) > 2 {
			entry.HTMLPath = strings.TrimSpace(fields[2])
			if entry.HTMLPath != "" && !isSafeRepoRelativePath(entry.HTMLPath) {
				entry.HTMLPath = ""
			}
		}
		if len(fields) > 3 {
			entry.Format = strings.TrimSpace(fields[3])
		}
		if len(fields) > 4 {
			entry.Date = strings.TrimSpace(fields[4])
		}
		if entry.ReportNumber == "" || entry.PDFPath == "" || !isSafeRepoRelativePath(entry.PDFPath) {
			continue
		}
		manifest[normalizeReportKey(entry.ReportNumber)] = entry
	}
	return manifest
}

// rePDFDate extracts the trailing YYYY-MM-DD stamp from generated CV
// filenames (cv-{candidate}-{slug}-{date}.pdf).
// Matches both naming schemes:
//   legacy:  cv-mathieu-agee-toast-2026-08-04.pdf   (date trailing)
//   current: toast-2026-08-04-cv.pdf                (date followed by kind)
// Without the optional kind suffix the current scheme would never match and
// every candidate would silently fall back to mtime ordering.
var rePDFDate = regexp.MustCompile(`(\d{4}-\d{2}-\d{2})(?:-(?:cv|cover))?\.pdf$`)

// ResolvePDFs returns candidate PDF paths (relative to careerOpsPath) for an
// application, best match first.
//
// Precedence:
//  1. Manifest entry for the application's report number, when the file
//     still exists. This is exact — generate-pdf.mjs recorded the linkage.
//  2. Filename match: a CV PDF whose name contains the kebab-cased company.
//     This covers every PDF generated before the manifest existed.
//     Multiple matches are all returned (newest first) so the caller can
//     offer a picker instead of guessing — one company can have several
//     role-variant CVs from the same day.
//
// Two filename schemes are recognised: the current {company}-{date}-cv.pdf
// and the legacy cv-{candidate}-{company}-{date}.pdf. Cover letters are
// deliberately excluded — this resolves the CV.
func ResolvePDFs(careerOpsPath string, app model.CareerApplication, manifest PDFManifest) []string {
	if entry, ok := manifest.Lookup(app); ok {
		if _, err := os.Stat(filepath.Join(careerOpsPath, filepath.FromSlash(entry.PDFPath))); err == nil {
			return []string{entry.PDFPath}
		}
	}

	slug := kebabCase(app.Company)
	if slug == "" {
		return nil
	}

	globbed, err := globCVFiles(careerOpsPath, "pdf")
	if err != nil {
		return nil
	}

	var matches []string
	for _, p := range globbed {
		base := strings.ToLower(filepath.Base(p))
		if matchesCompanySlug(base, slug) {
			if rel, err := filepath.Rel(careerOpsPath, p); err == nil {
				matches = append(matches, filepath.ToSlash(rel))
			}
		}
	}

	sortPDFsNewestFirst(careerOpsPath, matches)
	return matches
}

// matchesCompanySlug reports whether a generated CV filename refers to the
// company. Short slugs (< 3 runes) require a full "-slug-" segment so a
// company like "X" can't match every file; longer slugs use substring
// containment, which tolerates role-variant suffixes (cv-…-anthropic-staff-
// ui-….pdf matches "anthropic").
func matchesCompanySlug(base, slug string) bool {
	if len([]rune(slug)) < 3 {
		return strings.Contains(base, "-"+slug+"-")
	}
	return strings.Contains(base, slug)
}

// sortPDFsNewestFirst orders candidate paths by the date stamp embedded in
// the filename (descending), falling back to file mtime when the stamp is
// missing or equal. A regenerated CV from today therefore outranks last
// week's, and same-day variants get a stable mtime ordering.
func sortPDFsNewestFirst(careerOpsPath string, paths []string) {
	dateOf := func(p string) string {
		if m := rePDFDate.FindStringSubmatch(p); m != nil {
			return m[1]
		}
		return ""
	}
	mtimeOf := func(p string) int64 {
		info, err := os.Stat(filepath.Join(careerOpsPath, filepath.FromSlash(p)))
		if err != nil {
			return 0
		}
		return info.ModTime().UnixNano()
	}
	sort.SliceStable(paths, func(i, j int) bool {
		di, dj := dateOf(paths[i]), dateOf(paths[j])
		if di != dj {
			return di > dj
		}
		return mtimeOf(paths[i]) > mtimeOf(paths[j])
	})
}

// kebabCase lowercases s and collapses every non-alphanumeric run into a
// single hyphen: "Monarch Money" → "monarch-money".
func kebabCase(s string) string {
	var b strings.Builder
	lastHyphen := true // suppress leading hyphen
	for _, r := range strings.ToLower(s) {
		isAlnum := (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9')
		if isAlnum {
			b.WriteRune(r)
			lastHyphen = false
		} else if !lastHyphen {
			b.WriteByte('-')
			lastHyphen = true
		}
	}
	return strings.TrimRight(b.String(), "-")
}

// globCVFiles returns every CV artefact in output/ with the given extension,
// across both naming schemes:
//
//	current: {company}-{date}-cv.{ext}
//	legacy:  cv-{candidate}-{company}-{date}.{ext}
//
// Cover letters ({company}-{date}-cover.*) are excluded by construction: the
// current pattern requires a "-cv" suffix and the legacy one a "cv-" prefix.
func globCVFiles(careerOpsPath, ext string) ([]string, error) {
	current, err := filepath.Glob(filepath.Join(careerOpsPath, "output", "*-cv."+ext))
	if err != nil {
		return nil, err
	}
	legacy, err := filepath.Glob(filepath.Join(careerOpsPath, "output", "cv-*."+ext))
	if err != nil {
		return nil, err
	}
	seen := make(map[string]struct{}, len(current)+len(legacy))
	out := make([]string, 0, len(current)+len(legacy))
	for _, p := range append(current, legacy...) {
		if _, dup := seen[p]; dup {
			continue
		}
		seen[p] = struct{}{}
		out = append(out, p)
	}
	return out, nil
}

// ResolveHTML returns the newest CV HTML in output/ matching the company, and
// a companion PDF path derived from it (same base, .pdf extension). Returns
// ("","") when no matching HTML file is found. Used by the D handler to allow
// PDF generation for entries that have a tailored CV HTML but no prior PDF.
//
// Under the current scheme the HTML and PDF share a base ({company}-{date}-cv),
// so the derived path resolves to a real file. Under the legacy scheme it did
// not: the HTML carried no date while the PDF did, so the derived path pointed
// at a file that never existed and regeneration wrote to a dateless name.
func ResolveHTML(careerOpsPath string, app model.CareerApplication) (htmlPath, pdfPath string) {
	slug := kebabCase(app.Company)
	if slug == "" {
		return "", ""
	}
	globbed, err := globCVFiles(careerOpsPath, "html")
	if err != nil {
		return "", ""
	}
	var matches []string
	for _, p := range globbed {
		base := strings.ToLower(filepath.Base(p))
		if matchesCompanySlug(base, slug) {
			if rel, err := filepath.Rel(careerOpsPath, p); err == nil {
				matches = append(matches, filepath.ToSlash(rel))
			}
		}
	}
	if len(matches) == 0 {
		return "", ""
	}
	sortPDFsNewestFirst(careerOpsPath, matches)
	relHTML := matches[0]
	relPDF := strings.TrimSuffix(relHTML, ".html") + ".pdf"
	return relHTML, relPDF
}
