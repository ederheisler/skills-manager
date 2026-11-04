// Escape control and Unicode format characters before passing untrusted text to
// a terminal renderer. These helpers change display text, never source names.
const unsafeCharacters = /[\u0000-\u001f\u007f-\u009f\p{Cf}]/gu;

function escapeCharacter(character: string): string {
  switch (character) {
    case "\n": return "\\n";
    case "\r": return "\\r";
    case "\t": return "\\t";
    default: {
      const code = character.codePointAt(0)!;
      return code <= 0xff
        ? `\\x${code.toString(16).padStart(2, "0")}`
        : code <= 0xffff
          ? `\\u${code.toString(16).padStart(4, "0")}`
          : `\\u{${code.toString(16)}}`;
    }
  }
}

/** Display untrusted metadata on one terminal line. */
export function escapeTerminalSingleLine(value: string): string {
  return value.replace(unsafeCharacters, escapeCharacter);
}

/** Display file content while preserving intentional line breaks and tabs. */
export function escapeTerminalMultiline(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(unsafeCharacters, (character) =>
    character === "\n" || character === "\t" ? character : escapeCharacter(character),
  );
}

/** Quote a POSIX path or link target unambiguously for display. */
export function quoteTerminalPath(value: string): string {
  return `"${value.replace(/[\\"\u0000-\u001f\u007f-\u009f\p{Cf}]/gu, (character) => {
    if (character === "\\" || character === '"') return `\\${character}`;
    return escapeCharacter(character);
  })}"`;
}
