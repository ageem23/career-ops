import { cache } from "react";
import type { Metadata } from "next";
import { findApplication, readReport } from "@/lib/career-ops";
import { parseReport } from "@/lib/format";
import { applicationTabName, applicationTabTitle } from "@/lib/tab-title.mjs";

/** Company-first tab title for /pipeline/[id] pages; cached per request. */
const tabName = cache((id: string): string => {
  const app = findApplication(id);
  const reportTitle = app?.company ? null : parseReport(readReport(id)?.content ?? "").title;
  return applicationTabName({ company: app?.company, reportTitle });
});

export async function applicationMetadata(params: Promise<{ id: string }>, section?: string): Promise<Metadata> {
  const { id } = await params;
  return { title: applicationTabTitle(tabName(id), section) };
}
