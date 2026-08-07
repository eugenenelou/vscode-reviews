import { relative } from "node:path";

export interface ParsedLocation {
  relPath: string;
  shortSha?: string;
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
