import { describe, expect, it } from "vitest";
import { declaredAuthors } from "../../src/state/provenance.js";

describe("declaredAuthors", () => {
  it("returns declared names independently from source", () => {
    expect(declaredAuthors({ author: "Ada" })).toEqual(["Ada"]);
    expect(declaredAuthors({ authors: ["Ada", "Grace"], metadata: { author: "Ada" } })).toEqual(["Ada", "Grace"]);
    expect(declaredAuthors({ metadata: { authors: ["Ari", "Bo"] } })).toEqual(["Ari", "Bo"]);
  });

  it("returns unknown for absent, empty, or invalid declarations", () => {
    expect(declaredAuthors(null)).toEqual([]);
    expect(declaredAuthors({})).toEqual([]);
    expect(declaredAuthors({ author: 123 })).toEqual([]);
    expect(declaredAuthors({ authors: ["Ada", 4] })).toEqual([]);
  });
});
