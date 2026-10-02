import { describe, expect, it } from "vitest";
import { guideError } from "./validateGuide";

const valid = {
  branch: "eugene/foo",
  base: "c".repeat(40),
  createdAt: 1000,
  commits: [
    {
      sha: "a".repeat(40),
      patchId: "p1",
      subject: "feat: add x",
      summary: "adds x",
      files: [{ path: "src/a.ts", tier: "critical", reason: "core" }],
    },
  ],
};

describe("guideError", () => {
  it("accepts a valid guide", () => {
    expect(guideError(JSON.stringify(valid))).toBeUndefined();
  });

  it("names the offending field", () => {
    const guide = structuredClone(valid);
    delete (guide.commits[0].files[0] as { reason?: string }).reason;
    expect(guideError(JSON.stringify(guide))).toBe(
      "guide.commits[0].files[0].reason: expected a string",
    );
  });

  it("reports malformed JSON", () => {
    expect(guideError("{")).toMatch(/^invalid JSON: /);
  });
});
