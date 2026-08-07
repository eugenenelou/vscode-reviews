import { randomUUID } from "node:crypto";
import type { Review, ReviewComment } from "./types";

export interface ReviewStorePersistedState {
  active: Review | null;
  past: Review[];
}

export interface ReviewStoreOptions {
  /** idle timeout in ms before a continue/new prompt is needed; default 1h */
  timeoutMs?: number;
  initialState?: ReviewStorePersistedState;
  /** called with the plain-JSON state after every mutation, for slice 2 to persist */
  onChange?: (state: ReviewStorePersistedState) => void;
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
  private readonly onChange?: (state: ReviewStorePersistedState) => void;
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
   * review immediately.
   */
  rememberContinueAnswer(continueReview: boolean, now: number): void {
    this.remembered = { continueReview, expiresAt: now + this.timeoutMs };
    if (!continueReview) {
      this.startNewReview(now);
    } else {
      this.persist();
    }
  }

  addComment(input: NewCommentInput, now: number): ReviewComment {
    const comment: ReviewComment = { ...input, id: randomUUID() };
    if (!this.active) {
      this.active = {
        id: randomUUID(),
        createdAt: now,
        lastActivityAt: now,
        comments: [comment],
      };
    } else {
      this.active.comments.push(comment);
      this.active.lastActivityAt = now;
    }
    this.persist();
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
    this.persist();
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
    this.persist();
  }

  /** Archives the active review (if any) and starts fresh. */
  startNewReview(now: number): void {
    if (this.active) {
      this.past.unshift(this.active);
    }
    this.active = null;
    this.remembered = null;
    this.persist();
  }

  deleteReview(reviewId: string): void {
    if (this.active?.id === reviewId) {
      this.active = null;
    } else {
      this.past = this.past.filter((r) => r.id !== reviewId);
    }
    this.persist();
  }

  private findReview(reviewId: string): Review | undefined {
    if (this.active?.id === reviewId) {
      return this.active;
    }
    return this.past.find((r) => r.id === reviewId);
  }

  private persist(): void {
    this.onChange?.({ active: this.active, past: this.past });
  }
}
