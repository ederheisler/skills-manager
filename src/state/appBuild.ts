import { readFile } from "node:fs/promises";

export interface BuildIdentity {
  version: string;
  commit: string | null;
  dirty: boolean;
  source: "git" | "archive" | "unknown";
}

export async function readBuildIdentity(): Promise<BuildIdentity> {
  let version = "unknown";
  try {
    const manifest = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
    if (typeof manifest?.version === "string" && manifest.version.length <= 128 &&
        /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(manifest.version)) {
      version = manifest.version;
    }
  } catch {
    // A development or incomplete installation may not have package metadata.
  }

  const unknown: BuildIdentity = { version, commit: null, dirty: false, source: "unknown" };
  try {
    const identity = JSON.parse(await readFile(new URL("./buildIdentity.json", import.meta.url), "utf8"));
    if ((identity?.source === "git" || identity?.source === "archive") &&
        typeof identity.commit === "string" && /^[0-9a-f]{40}$/.test(identity.commit) &&
        typeof identity.dirty === "boolean") {
      return { version, commit: identity.commit, dirty: identity.dirty, source: identity.source };
    }
  } catch {
    // Older builds and invalid metadata are unknown, never inferred from cwd or Git.
  }
  return unknown;
}
