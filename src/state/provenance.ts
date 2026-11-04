import type { SkillFrontmatter } from "./types.js";

/** Declared names are metadata, not proof of authorship or ownership. */
export function declaredAuthors(frontmatter: SkillFrontmatter | null): string[] {
  if (!frontmatter) return [];
  const metadata = frontmatter.metadata;
  const values = [frontmatter.author, frontmatter.authors, metadata?.author, metadata?.authors];
  const names = new Set<string>();
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const candidates = typeof value === "string" ? [value] : value;
    if (!Array.isArray(candidates) || !candidates.every((name) => typeof name === "string" && name.trim() !== "")) continue;
    for (const name of candidates) {
      const normalized = name.trim();
      names.add(normalized);
    }
  }
  return [...names];
}
