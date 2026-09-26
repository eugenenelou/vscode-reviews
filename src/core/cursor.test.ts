import { describe, expect, it } from "vitest";
import {
  findRebasedSha,
  gitLensCommitRef,
  parsePatchIds,
  reviewTagName,
} from "./cursor";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

describe("reviewTagName", () => {
  it("prefixes the branch, keeping its slashes", () => {
    expect(reviewTagName("eugene/foo")).toBe("rv/eugene/foo");
  });
});

describe("parsePatchIds", () => {
  it("parses one entry per line and skips blank lines", () => {
    expect(parsePatchIds(`p1 ${SHA_A}\np2 ${SHA_B}\n\n`)).toEqual([
      { patchId: "p1", sha: SHA_A },
      { patchId: "p2", sha: SHA_B },
    ]);
  });
});

describe("findRebasedSha", () => {
  it("returns the first candidate with the target patch-id, or undefined", () => {
    const candidates = [
      { patchId: "p1", sha: SHA_A },
      { patchId: "p2", sha: SHA_B },
    ];
    expect(findRebasedSha("p2", candidates)).toBe(SHA_B);
    expect(findRebasedSha("p3", candidates)).toBeUndefined();
  });
});

describe("gitLensCommitRef", () => {
  it("reads sha and repoPath from node.commit", () => {
    const node = { commit: { sha: SHA_A, repoPath: "/repo" } };
    expect(gitLensCommitRef(node)).toEqual({ sha: SHA_A, repoPath: "/repo" });
  });

  it("rejects nodes of another shape or with a non-sha ref", () => {
    expect(gitLensCommitRef(undefined)).toBeUndefined();
    expect(gitLensCommitRef({ sha: SHA_A, repoPath: "/repo" })).toBeUndefined();
    expect(
      gitLensCommitRef({ commit: { sha: "HEAD", repoPath: "/repo" } }),
    ).toBeUndefined();
  });
});
