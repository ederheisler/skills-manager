import { describe, expect, it } from "vitest";
import { escapeTerminalMultiline, escapeTerminalSingleLine, quoteTerminalPath } from "../src/terminalText.js";

describe("terminal text display boundaries", () => {
  it("escapes terminal control sequences in single-line metadata", () => {
    expect(escapeTerminalSingleLine("prefix \u001b]0;title\u0007\n\t\r\u007f\u009b31m\u009d8;;url\u009c"))
      .toBe("prefix \\x1b]0;title\\x07\\n\\t\\r\\x7f\\x9b31m\\x9d8;;url\\x9c");
    expect(escapeTerminalSingleLine("ordinary café 漢字")).toBe("ordinary café 漢字");
  });

  it("keeps Markdown line breaks and tabs while neutralizing other controls", () => {
    const input = "# Café\r\n\t- hello\nworld\rnext \u001b]0;title\u0007 \u0085\u202eend";
    expect(escapeTerminalMultiline(input)).toBe("# Café\n\t- hello\nworld\\rnext \\x1b]0;title\\x07 \\x85\\u202eend");
    expect(input).toBe("# Café\r\n\t- hello\nworld\rnext \u001b]0;title\u0007 \u0085\u202eend");
  });

  it("quotes paths without confusing actual controls with literal escapes", () => {
    expect(quoteTerminalPath("a\nb")).toBe('"a\\nb"');
    expect(quoteTerminalPath("a\\nb")).toBe('"a\\\\nb"');
    expect(quoteTerminalPath('dir/"name"\\target\u202e.txt')).toBe('"dir/\\"name\\"\\\\target\\u202e.txt"');
    expect(quoteTerminalPath("résumé/漢字")).toBe('"résumé/漢字"');
  });

  it("exposes invisible format characters and C0, DEL, and C1 controls", () => {
    expect(escapeTerminalSingleLine("a\u200bb\u200dc\u2066d\u2069e\ufefff"))
      .toBe("a\\u200bb\\u200dc\\u2066d\\u2069e\\ufefff");
    expect(quoteTerminalPath("\u0000\u001f\u007f\u0080\u009f")).toBe('"\\x00\\x1f\\x7f\\x80\\x9f"');
  });
});
