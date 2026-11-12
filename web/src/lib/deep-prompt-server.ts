import fs from "node:fs";
import * as yaml from "js-yaml";
import { careerOpsRoot } from "@/lib/career-ops";
import { getProfilePath } from "@/lib/core/profile-path.mjs";
import { deepResearchUrlFromProfile } from "@/lib/deep-prompt.mjs";

/** `deep_research.claude_url` from config/profile.yml, or "" (use the default new-chat link). */
export function readDeepResearchUrl(): string {
  try {
    return deepResearchUrlFromProfile(yaml.load(fs.readFileSync(getProfilePath(careerOpsRoot()), "utf8")));
  } catch {
    return "";
  }
}
