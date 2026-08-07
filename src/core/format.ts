import type { Review, ReviewComment } from "./types";

function formatLocation(comment: ReviewComment): string {
  const line =
    comment.startLine === comment.endLine
      ? `${comment.startLine}`
      : `${comment.startLine}-${comment.endLine}`;
  const sha = comment.shortSha ? `@${comment.shortSha}` : "";
  return `${comment.path}:${line}${sha}`;
}

export function formatPrompt(review: Review): string {
  return review.comments
    .map((comment) => `${formatLocation(comment)}\n${comment.text}`)
    .join("\n---\n");
}

/** First line of a comment, truncated for a one-line sidebar label. */
export function excerptComment(text: string, maxLength = 40): string {
  const firstLine = text.split("\n")[0]?.trim() ?? "";
  if (firstLine.length <= maxLength) {
    return firstLine;
  }
  return `${firstLine.slice(0, maxLength).trimEnd()}…`;
}
