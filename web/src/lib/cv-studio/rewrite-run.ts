import { spawnHeadlessCli } from "@/lib/spawn-cli.mjs";
import { fencingReport } from "@/lib/cli-fencing.mjs";
import { CAPS } from "@/lib/worker-capabilities.mjs";
import { scopeFrom } from "@/lib/claude-invocation.mjs";
import { resolveCliOrFallback } from "@/lib/clis";
import { careerOpsRoot } from "@/lib/career-ops";
import { rewriteGate } from "@/lib/cv-studio/rewrite.mjs";
import { spillOversizedPrompt } from "@/lib/oversized-prompt.mjs";

// Deny list derived, never hand-written (#2185, #2507). The rewrite needs no
// tools at all; Read is the narrowest scope the Claude argv accepts.
const REWRITE_SCOPE = scopeFrom("Read");
const KILL_MS = 120_000;

export type RewriteRun = { ok: true; reply: string; warning: string | null } | { ok: false; reason: "no-cli" | "unfenced" | "refused" | "failed"; detail?: string };

/**
 * Run one read-only prompt through the user's agent CLI. `killMs` lets the
 * whole-CV prompt (assist.mjs) take longer than a one-bullet rewrite; a prompt
 * too long for the OS command line (a whole CV is) moves to a file the agent
 * Reads, the same way /api/run handles it.
 */
export function runRewrite(cliId: string, prompt: string, { killMs = KILL_MS }: { killMs?: number } = {}): Promise<RewriteRun> {
  const resolved = resolveCliOrFallback(cliId);
  if (!resolved) return Promise.resolve({ ok: false, reason: "no-cli" });
  const { spec, binPath } = resolved;
  const fencing = fencingReport({ cliId: spec.id, cliName: spec.name, capabilities: CAPS.localReadOnly });
  const gate = rewriteGate(spec.id, fencing);
  if (!gate.run) return Promise.resolve({ ok: false, reason: "unfenced", detail: fencing.notice ?? undefined });
  const buildArgs = (p: string) =>
    spec.id === "claude"
      ? ["-p", p, "--permission-mode", "acceptEdits", "--strict-mcp-config", "--allowedTools", REWRITE_SCOPE.allowed, "--disallowedTools", REWRITE_SCOPE.disallowed]
      : spec.args(p);
  let spill: ReturnType<typeof spillOversizedPrompt>;
  try {
    spill = spillOversizedPrompt({ prompt, buildArgs, binPath, fencing: { cliId: spec.id, capabilities: CAPS.localReadOnly }, root: careerOpsRoot() });
  } catch (e) {
    return Promise.resolve({ ok: false, reason: "refused", detail: e instanceof Error ? e.message : undefined });
  }
  const args = spill.args;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnHeadlessCli(binPath, args, { cwd: careerOpsRoot(), env: process.env }, { cliId: spec.id, capabilities: CAPS.localReadOnly });
    } catch (e) {
      spill.cleanup?.();
      return resolve({ ok: false, reason: "refused", detail: e instanceof Error ? e.message : undefined });
    }
    if (spill.cleanup) child.once("close", spill.cleanup);
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    const killer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
      resolve({ ok: false, reason: "failed", detail: `no reply after ${killMs / 1000}s` });
    }, killMs);
    child.on("close", (code: number | null) => {
      clearTimeout(killer);
      resolve(code === 0 ? { ok: true, reply: out, warning: gate.warning } : { ok: false, reason: "failed", detail: err.trim().split("\n").filter(Boolean).at(-1)?.slice(0, 300) });
    });
    child.on("error", (e: Error) => {
      clearTimeout(killer);
      resolve({ ok: false, reason: "failed", detail: e.message });
    });
  });
}
