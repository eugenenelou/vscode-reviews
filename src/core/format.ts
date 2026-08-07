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
