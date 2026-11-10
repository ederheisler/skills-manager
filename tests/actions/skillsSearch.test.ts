import { access, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findSkills } from "../../src/actions/skillsSearch.js";

const header = "Install with npx skills add <owner/repo@skill>\n\n";

describe("confined skills search", () => {
  it("returns CLI results in order with the displayed installation counts and safe URLs", async () => {
    let workspace = "";
    const results = await findSkills("design systems", async (root) => {
      workspace = root;
      await writeFile(path.join(root, "tmp", "temporary"), "test");
      return { stdout: `\x1b[38;5;102m${header}\x1b[0mowner/repo@design 1.2K installs\n└ https://skills.sh/owner/repo/design\n\nother/tool@single 1 install\n└ https://skills.sh/other/tool/single\n\nthird/repo@fresh\n└ https://skills.sh/third/repo/fresh\n\n`, stderr: "" };
    });
    expect(results).toEqual([
      { identifier: "owner/repo@design", repository: "owner/repo", skill: "design", installs: "1.2K", url: "https://skills.sh/owner/repo/design" },
      { identifier: "other/tool@single", repository: "other/tool", skill: "single", installs: "1", url: "https://skills.sh/other/tool/single" },
      { identifier: "third/repo@fresh", repository: "third/repo", skill: "fresh", installs: "0", url: "https://skills.sh/third/repo/fresh" },
    ]);
    await expect(access(workspace)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("parses the real CLI banner and domain source without changing the result order", async () => {
    const stdout = `
\u001b[38;5;250m███████╗██╗  ██╗██╗██╗     ██╗     ███████╗\u001b[0m
\u001b[38;5;248m██╔════╝██║ ██╔╝██║██║     ██║     ██╔════╝\u001b[0m
\u001b[38;5;245m███████╗█████╔╝ ██║██║     ██║     ███████╗\u001b[0m
\u001b[38;5;243m╚════██║██╔═██╗ ██║██║     ██║     ╚════██║\u001b[0m
\u001b[38;5;240m███████║██║  ██╗██║███████╗███████╗███████║\u001b[0m
\u001b[38;5;238m╚══════╝╚═╝  ╚═╝╚═╝╚══════╝╚══════╝╚══════╝\u001b[0m

\u001b[38;5;102mInstall with\u001b[0m npx skills add <owner/repo@skill>

\u001b[38;5;145mwshobson/agents@typescript-advanced-types\u001b[0m \u001b[36m98.7K installs\u001b[0m
\u001b[38;5;102m└ https://skills.sh/wshobson/agents/typescript-advanced-types\u001b[0m

\u001b[38;5;145mskills.volces.com@byted-supabase\u001b[0m \u001b[36m11.9K installs\u001b[0m
\u001b[38;5;102m└ https://skills.sh/skills.volces.com/byted-supabase\u001b[0m
`;
    expect(await findSkills("typescript", async () => ({ stdout, stderr: "" }))).toEqual([
      { identifier: "wshobson/agents@typescript-advanced-types", repository: "wshobson/agents", skill: "typescript-advanced-types", installs: "98.7K", url: "https://skills.sh/wshobson/agents/typescript-advanced-types" },
      { identifier: "skills.volces.com@byted-supabase", repository: "skills.volces.com", skill: "byted-supabase", installs: "11.9K", url: "https://skills.sh/skills.volces.com/byted-supabase" },
    ]);
  });

  it("accepts the CLI's no-results verdict", async () => {
    expect(await findSkills("missing", async () => ({ stdout: '\u001b[38;5;102mNo skills found for "missing"\u001b[0m\n', stderr: "" }))).toEqual([]);
  });

  it.each(["", "  ", "--owner=attacker", "bad\nquery", "bad\u007fquery", "bad\u202equery"])("rejects unsafe query %j before invoking the CLI", async (query) => {
    let invoked = false;
    await expect(findSkills(query, async () => { invoked = true; return { stdout: "", stderr: "" }; })).rejects.toThrow();
    expect(invoked).toBe(false);
  });

  it.each([
    "",
    'No skills found for "another query"\n',
    `${header}owner/repo@skill 2 installs\n`,
    `${header}owner/../repo@skill 2 installs\n└ https://skills.sh/owner/repo/skill\n`,
    `${header}owner/repo@.. 2 installs\n└ https://skills.sh/owner/repo/skill\n`,
    `${header}owner/repo@skill 2 installs\n└ https://skills.sh/owner/../secret\n`,
    `${header}owner/repo@skill 2 installs\n└ https://skills.sh.evil.example/owner/repo/skill\n`,
    `${header}owner/repo@skill 2 installs\n└ https://skills.sh/owner/repo/skill?redirect=evil\n`,
    `${header}owner/repo@skill nonsense\n└ https://skills.sh/owner/repo/skill\n`,
    `${header}owner/repo@skill 2 installs\n└ https://skills.sh/owner/repo/skill\nUnexpected diagnostic\n`,
  ])("rejects unrecognized or unsafe CLI output %#", async (stdout) => {
    let workspace = "";
    await expect(findSkills("query", async (root) => { workspace = root; return { stdout, stderr: "" }; })).rejects.toThrow();
    await expect(access(workspace)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects diagnostics rather than interpreting them as results", async () => {
    await expect(findSkills("query", async () => ({ stdout: 'No skills found for "query"\n', stderr: "unexpected error" }))).rejects.toThrow();
  });

  it("propagates child failures and cleans the disposable workspace", async () => {
    let workspace = "";
    const failure = new Error("sandbox failed");
    await expect(findSkills("query", async (root) => { workspace = root; throw failure; })).rejects.toBe(failure);
    await expect(access(workspace)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
