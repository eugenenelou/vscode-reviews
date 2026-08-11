import { join, relative } from "node:path";

export interface ParsedLocation {
  relPath: string;
  shortSha?: string;
}

/** The parts of a `git:` URI, matching what the built-in Git extension's filesystem provider expects. */
export interface RevisionUriParts {
  scheme: string;
  path: string;
  query: string;
}

const NON_SHA_REFS = new Set(["", "~", "head"]);

function toRelPath(fsPath: string, workspaceRoot: string): string {
  return relative(workspaceRoot, fsPath).split("\\").join("/");
}

function shaFromRef(ref: string | undefined): string | undefined {
  if (!ref || NON_SHA_REFS.has(ref.toLowerCase())) {
    return undefined;
  }
  return ref.slice(0, 7);
}

/**
 * Parses a document URI (file://, gitlens://, or git://) into a repo-relative
 * path plus, for committed diff versions, a short sha.
 */
export function parseLocation(
  uriString: string,
  workspaceRoot: string,
): ParsedLocation {
  const url = new URL(uriString);
  const fsPath = decodeURIComponent(url.pathname);

  if (url.protocol === "file:") {
    return { relPath: toRelPath(fsPath, workspaceRoot) };
  }

  // gitlens:// and git:// carry a JSON query string with a `ref` field
  const query = url.search.startsWith("?") ? url.search.slice(1) : url.search;
  const parsed = query
    ? (JSON.parse(decodeURIComponent(query)) as { ref?: string })
    : {};
  return {
    relPath: toRelPath(fsPath, workspaceRoot),
    shortSha: shaFromRef(parsed.ref),
  };
}

/**
 * Builds the parts of a `git:` URI for a file at a given revision, in the
 * shape the built-in Git extension's filesystem provider (and `parseLocation`
 * above) understand.
 */
export function buildRevisionUri(
  relPath: string,
  ref: string,
  workspaceRoot: string,
): RevisionUriParts {
  const fsPath = join(workspaceRoot, relPath).split("\\").join("/");
  return {
    scheme: "git",
    path: fsPath,
    query: JSON.stringify({ path: fsPath, ref }),
  };
}
