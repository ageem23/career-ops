import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";
import { careerOpsRoot, type Application } from "@/lib/career-ops";
import { resolveCodeRoot } from "@/lib/core/code-root.mjs";
import { getProfilePath } from "@/lib/core/profile-path.mjs";
import { localISODate } from "@/lib/followups";
import {
  buildContactoPrompt,
  extractContactoTemplate,
  outreachEligible,
  profileLinkedin,
  profileSummary,
} from "@/lib/contacto-prompt.mjs";

function readIf(file: string): string | null {
  try {
    return fs.readFileSync(/* turbopackIgnore: true */ file, "utf8");
  } catch {
    return null;
  }
}

/**
 * The contacto research prompt for an application that has gone out
 * (Applied/Responded/Assessment/Interview), or "" before that, or when the
 * mode file has no MODE A template. modes/contacto.md is system layer, so it
 * comes from the code checkout; the profile comes from the data root.
 */
export function contactoPromptFor(app: Application | null, postingUrl = ""): string {
  if (!app || !outreachEligible(app.status)) return "";
  const mode = readIf(path.join(/* turbopackIgnore: true */ resolveCodeRoot(process.cwd(), process.env), "modes", "contacto.md"));
  const template = extractContactoTemplate(mode);
  if (!template) return "";
  let profile: unknown = null;
  try {
    profile = yaml.load(readIf(getProfilePath(careerOpsRoot())) ?? "");
  } catch {
    profile = null;
  }
  const appNum = Number.parseInt(app.n, 10);
  return buildContactoPrompt(template, {
    company: app.company,
    role: app.role,
    url: postingUrl,
    today: localISODate(),
    appNum: Number.isFinite(appNum) && appNum > 0 ? appNum : null,
    summary: profileSummary(profile),
    linkedin: profileLinkedin(profile),
    location: app.location && app.location !== "—" ? app.location : "",
  });
}
