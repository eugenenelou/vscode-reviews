export interface ReviewComment {
  id: string;
  /** repo-relative path */
  path: string;
  startLine: number;
  endLine: number;
  /** short (7-char) commit sha, present only for comments made on a committed diff version */
  shortSha?: string;
  text: string;
}

export interface Review {
  id: string;
  createdAt: number;
  lastActivityAt: number;
  comments: ReviewComment[];
}
