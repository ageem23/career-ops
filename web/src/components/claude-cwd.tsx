"use client";

import { createContext, useContext } from "react";

/**
 * The project folder a Claude Code handoff link opens in (claude-code-handoff.mjs).
 * Resolved on the server in the root layout and provided by AppShell, so
 * client pages can build handoff links without a request.
 */
const ClaudeCwdContext = createContext("");

export function ClaudeCwdProvider({ cwd, children }: { cwd: string; children: React.ReactNode }) {
  return <ClaudeCwdContext.Provider value={cwd}>{children}</ClaudeCwdContext.Provider>;
}

export function useClaudeCwd(): string {
  return useContext(ClaudeCwdContext);
}
