import { randomUUID } from "node:crypto";
import type { Review, ReviewComment } from "./types";

export interface ReviewStorePersistedState {
  active: Review | null;
  past: Review[];
}

/** One review's file needs (re)writing, or a review's file needs removing. */
export type StoreChange =
  | { kind: "save"; review: Review }
  | { kind: "delete"; reviewId: string };

export interface ReviewStoreOptions {
  /** idle timeout in ms before a continue/new prompt is needed; default 1h */
  timeoutMs?: number;
  initialState?: ReviewStorePersistedState;
  /** called after each mutation with exactly the review(s) that need writing/deleting on disk */
  onChange?: (change: StoreChange) => void;
}

export type NewCommentInput = Omit<ReviewComment, "id">;

const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;

interface RememberedAnswer {
  continueReview: boolean;
  expiresAt: number;
}

export class ReviewStore {
  private active: Review | null;
  private past: Review[];
  private readonly timeoutMs: number;
  private readonly onChange?: (change: StoreChange) => void;
  private remembered: RememberedAnswer | null = null;

  constructor(options: ReviewStoreOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.active = options.initialState?.active ?? null;
    this.past = options.initialState?.past ?? [];
    this.onChange = options.onChange;
  }

  getActiveReview(): Review | null {
    return this.active;
  }

  listPastReviews(): Review[] {
    return this.past;
  }

  /** Looks up the active review or a past review by id. */
  getReview(reviewId: string): Review | undefined {
    return this.findReview(reviewId);
  }

  needsContinuePrompt(now: number): boolean {
    if (!this.active) {
      return false;
    }
    if (now - this.active.lastActivityAt <= this.timeoutMs) {
      return false;
    }
    if (this.remembered && now <= this.remembered.expiresAt) {
      return false;
    }
    return true;
  }

  /**
   * Records the answer to the continue/new question so it is not asked again
   * for the same timeout duration. Answering "start new" archives the active
   * review immediately. The remembered answer itself is in-memory only, not
   * part of the on-disk contract, so it never triggers a write.
   */
  rememberContinueAnswer(continueReview: boolean, now: number): void {
    this.remembered = { continueReview, expiresAt: now + this.timeoutMs };
    if (!continueReview) {
      this.startNewReview(now);
    }
  }

  addComment(input: NewCommentInput, now: number): ReviewComment {
    const comment: ReviewComment = { ...input, id: randomUUID() };
    if (!this.active) {
      this.active = {
        id: randomUUID(),
        createdAt: now,
        lastActivityAt: now,
        archivedAt: null,
        comments: [comment],
      };
    } else {
      this.active.comments.push(comment);
      this.active.lastActivityAt = now;
    }
    this.notify({ kind: "save", review: this.active });
    return comment;
  }

  /** Edits a comment in the active review by default, or in `reviewId` (active or past) when given. */
  editComment(
    commentId: string,
    updates: Partial<Omit<ReviewComment, "id">>,
    now: number,
    reviewId?: string,
  ): void {
    const review = reviewId ? this.findReview(reviewId) : this.active;
    const comment = review?.comments.find((c) => c.id === commentId);
    if (!comment || !review) {
      return;
    }
    Object.assign(comment, updates);
    if (review === this.active) {
      review.lastActivityAt = now;
    }
    this.notify({ kind: "save", review });
  }

  /** Deletes a comment from the active review by default, or from `reviewId` (active or past) when given. */
  deleteComment(commentId: string, now: number, reviewId?: string): void {
    const review = reviewId ? this.findReview(reviewId) : this.active;
    if (!review) {
      return;
    }
    review.comments = review.comments.filter((c) => c.id !== commentId);
    if (review === this.active) {
      review.lastActivityAt = now;
    }
    this.notify({ kind: "save", review });
  }

  /** Archives the active review (if any) and starts fresh. */
  startNewReview(now: number): void {
    if (this.active) {
      this.active.archivedAt = now;
      this.past.unshift(this.active);
      this.notify({ kind: "save", review: this.active });
    }
    this.active = null;
    this.remembered = null;
  }

  deleteReview(reviewId: string): void {
    if (this.active?.id === reviewId) {
      this.active = null;
    } else {
      this.past = this.past.filter((r) => r.id !== reviewId);
    }
    this.notify({ kind: "delete", reviewId });
  }

  private findReview(reviewId: string): Review | undefined {
    if (this.active?.id === reviewId) {
      return this.active;
    }
    return this.past.find((r) => r.id === reviewId);
  }

  private notify(change: StoreChange): void {
    this.onChange?.(change);
  }
}
