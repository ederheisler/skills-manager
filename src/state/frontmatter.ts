import { CST, Lexer, Parser, isAlias, isCollection, isMap, isPair, isScalar, isSeq, parseDocument } from "yaml";
import type { Document } from "yaml";
import { isSkillFrontmatter } from "./validation.js";
import type { SkillFrontmatter } from "./types.js";

const MAX_FRONTMATTER_BYTES = 64 * 1024;
const MAX_DEPTH = 50;
const MAX_ALIASES = 100;
const MAX_EXPANDED_BYTES = 1024 * 1024;

export interface ParsedSkillDocument {
  frontmatter: SkillFrontmatter | null;
  text: string;
  warnings: string[];
}

class FrontmatterError extends Error {}

// Inspect the parser stack before composing a document. This bounds the
// composer's recursion even for malicious deeply nested flow collections.
function checkSyntaxDepth(source: string): void {
  const parser = new Parser();
  for (const lexeme of new Lexer().lex(source)) {
    for (const _token of parser.next(lexeme)) { /* drain the parser */ }
    let depth = 0;
    for (const token of parser.stack) if (CST.isCollection(token)) depth++;
    if (depth > MAX_DEPTH) throw new FrontmatterError("YAML frontmatter exceeds the nesting depth limit of 50.");
  }
}

interface SizeAndDepth {
  size: number;
  depth: number;
}

/** Check the complete expanded JSON representation without expanding aliases. */
function checkDocumentBudget(doc: Document): void {
  let aliases = 0;
  const pending: unknown[] = [doc.contents];
  while (pending.length > 0) {
    const node = pending.pop();
    if (isAlias(node)) {
      if (++aliases > MAX_ALIASES) throw new FrontmatterError("YAML frontmatter exceeds the limit of 100 aliases.");
    } else if (isPair(node)) {
      pending.push(node.key, node.value);
    } else if (isCollection(node)) {
      if (node.tag && !["tag:yaml.org,2002:map", "tag:yaml.org,2002:seq"].includes(node.tag)) {
        throw new FrontmatterError("Unsupported YAML tag in frontmatter.");
      }
      pending.push(...node.items);
    } else if (isScalar(node) && node.tag && ![
      "tag:yaml.org,2002:str", "tag:yaml.org,2002:bool", "tag:yaml.org,2002:int",
      "tag:yaml.org,2002:float", "tag:yaml.org,2002:null",
    ].includes(node.tag)) {
      throw new FrontmatterError("Unsupported YAML tag in frontmatter.");
    }
  }

  const active = new Set<object>();
  const memo = new Map<object, SizeAndDepth>();
  const sizeOf = (node: unknown): SizeAndDepth => {
    if (node === null || node === undefined) return { size: 4, depth: 0 };
    if (typeof node !== "object") throw new FrontmatterError("Invalid YAML frontmatter node.");
    const cached = memo.get(node);
    if (cached) return cached;
    if (active.has(node)) throw new FrontmatterError("Cyclic YAML aliases are not supported.");
    active.add(node);
    let result: SizeAndDepth;
    if (isAlias(node)) {
      const target = node.resolve(doc);
      if (!target) throw new FrontmatterError("Unresolved YAML alias in frontmatter.");
      result = sizeOf(target);
    } else if (isScalar(node)) {
      const json = JSON.stringify(node.value);
      if (json === undefined) throw new FrontmatterError("Unsupported YAML scalar in frontmatter.");
      result = { size: Buffer.byteLength(json), depth: 0 };
    } else if (isSeq(node)) {
      let size = 2;
      let depth = 1;
      for (const item of node.items) {
        const child = sizeOf(item);
        size += child.size + (size > 2 ? 1 : 0);
        depth = Math.max(depth, child.depth + 1);
        if (size > MAX_EXPANDED_BYTES) throw new FrontmatterError("YAML frontmatter exceeds the 1 MiB expanded metadata limit.");
      }
      result = { size, depth };
    } else if (isMap(node)) {
      let size = 2;
      let depth = 1;
      for (const pair of node.items) {
        if (!isScalar(pair.key) || typeof pair.key.value !== "string") {
          throw new FrontmatterError("YAML frontmatter keys must be strings.");
        }
        const child = sizeOf(pair.value);
        size += Buffer.byteLength(JSON.stringify(pair.key.value)) + 1 + child.size + (size > 2 ? 1 : 0);
        depth = Math.max(depth, child.depth + 1);
        if (size > MAX_EXPANDED_BYTES) throw new FrontmatterError("YAML frontmatter exceeds the 1 MiB expanded metadata limit.");
      }
      result = { size, depth };
    } else {
      throw new FrontmatterError("Unsupported YAML value in frontmatter.");
    }
    active.delete(node);
    if (result.depth > MAX_DEPTH) throw new FrontmatterError("YAML frontmatter exceeds the nesting depth limit of 50.");
    if (result.size > MAX_EXPANDED_BYTES) throw new FrontmatterError("YAML frontmatter exceeds the 1 MiB expanded metadata limit.");
    memo.set(node, result);
    return result;
  };
  sizeOf(doc.contents);
}

/** A single, inert parser shared by skill discovery and text previews. */
export function parseSkillDocument(raw: string): ParsedSkillDocument {
  const invalid = (message: string): ParsedSkillDocument => ({ frontmatter: null, text: raw, warnings: [message] });
  const opening = /^(?:\uFEFF)?---([^\r\n]*)(?:\r?\n|$)/.exec(raw);
  if (!opening) return invalid("Missing YAML frontmatter.");
  if (opening[1].trim() !== "") return invalid("Unsupported frontmatter language; only YAML is accepted.");

  const start = opening[0].length;
  // Include enough bytes for the closing fence, without scanning an unbounded body.
  const region = raw.slice(start, start + MAX_FRONTMATTER_BYTES + 8);
  const closing = /^---[ \t]*(?:\r?\n|$)/m.exec(region);
  if (!closing || (closing.index + closing[0].length === region.length && start + region.length < raw.length && !closing[0].endsWith("\n"))) {
    if (Buffer.byteLength(region) > MAX_FRONTMATTER_BYTES || start + region.length < raw.length) {
      return invalid("YAML frontmatter exceeds the 64 KiB input limit or has no closing fence.");
    }
    return invalid("YAML frontmatter has no closing fence.");
  }
  const source = region.slice(0, closing.index);
  if (Buffer.byteLength(source) > MAX_FRONTMATTER_BYTES) return invalid("YAML frontmatter exceeds the 64 KiB input limit.");

  try {
    checkSyntaxDepth(source);
    const doc = parseDocument(source, { version: "1.2", schema: "core", merge: false, resolveKnownTags: false, stringKeys: true, prettyErrors: false });
    if (doc.errors.length || doc.warnings.length) throw new FrontmatterError("Invalid YAML or unsupported tag in frontmatter.");
    checkDocumentBudget(doc);
    // Expansion and cycles have already been bounded above; keep the YAML
    // library's automatic expansion heuristic from rejecting valid aliases.
    const data: unknown = doc.toJS({ maxAliasCount: -1 });
    if (!isSkillFrontmatter(data)) throw new FrontmatterError("Invalid skill frontmatter metadata.");
    return { frontmatter: data, text: raw.slice(start + closing.index + closing[0].length).trim(), warnings: [] };
  } catch (error) {
    return invalid(error instanceof FrontmatterError ? error.message : "Invalid or unsupported YAML frontmatter.");
  }
}
