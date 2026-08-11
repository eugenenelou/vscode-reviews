import { describe, expect, it } from "vitest";
import { buildRevisionUri, parseLocation } from "./location";

const ROOT = "/home/eugene/projects/vscode-reviews";

describe("parseLocation", () => {
  it("parses a plain file:// URI to a relative path with no sha", () => {
    const result = parseLocation(`file://${ROOT}/src/foo.ts`, ROOT);
    expect(result).toEqual({ relPath: "src/foo.ts" });
  });

  it("parses a gitlens:// revision URI, truncating the ref to a 7-char sha", () => {
    const query = encodeURIComponent(
      JSON.stringify({ ref: "abcdef1234567890" }),
    );
    const result = parseLocation(`gitlens:${ROOT}/src/foo.ts?${query}`, ROOT);
    expect(result).toEqual({ relPath: "src/foo.ts", shortSha: "abcdef1" });
  });

  it("parses a git:// URI, omitting the sha when ref is empty, '~', or HEAD", () => {
    for (const ref of ["", "~", "HEAD"]) {
      const query = encodeURIComponent(JSON.stringify({ ref }));
      const result = parseLocation(`git:${ROOT}/src/foo.ts?${query}`, ROOT);
      expect(result).toEqual({ relPath: "src/foo.ts", shortSha: undefined });
    }
  });

  it("parses a git:// URI with a real ref like a gitlens URI", () => {
    const query = encodeURIComponent(
      JSON.stringify({ ref: "1234567890abcdef" }),
    );
    const result = parseLocation(`git:${ROOT}/src/bar.ts?${query}`, ROOT);
    expect(result).toEqual({ relPath: "src/bar.ts", shortSha: "1234567" });
  });
});

describe("buildRevisionUri", () => {
  it("round-trips through parseLocation, agreeing on relPath and shortSha", () => {
    const ref = "abcdef1234567890";
    const parts = buildRevisionUri("src/foo.ts", ref, ROOT);
    const query = encodeURIComponent(parts.query);
    const uriString = `${parts.scheme}:${parts.path}?${query}`;

    const result = parseLocation(uriString, ROOT);

    expect(result).toEqual({ relPath: "src/foo.ts", shortSha: "abcdef1" });
  });
});
