import { describe, expect, it } from "vitest";
import { ReviewStore } from "./store";

const HOUR = 60 * 60 * 1000;

describe("ReviewStore", () => {
  it("auto-creates a review on first comment, appends and refreshes activity on later ones", () => {
    const store = new ReviewStore();
    const t0 = 1000;
    store.addComment(
      { path: "a.ts", startLine: 1, endLine: 1, text: "first" },
      t0,
    );

    const active = store.getActiveReview();
    expect(active).not.toBeNull();
    expect(active!.createdAt).toBe(t0);
    expect(active!.lastActivityAt).toBe(t0);
    expect(active!.comments).toHaveLength(1);

    const t1 = t0 + 5000;
    store.addComment(
      { path: "b.ts", startLine: 2, endLine: 2, text: "second" },
      t1,
    );
    const stillActive = store.getActiveReview();
    expect(stillActive!.id).toBe(active!.id);
    expect(stillActive!.comments).toHaveLength(2);
    expect(stillActive!.lastActivityAt).toBe(t1);
  });

  it("requires a continue/new prompt only after the idle timeout, and remembers the answer for the same duration", () => {
    const store = new ReviewStore({ timeoutMs: HOUR });
    const t0 = 0;
    store.addComment(
      { path: "a.ts", startLine: 1, endLine: 1, text: "first" },
      t0,
    );

    expect(store.needsContinuePrompt(t0 + HOUR - 1)).toBe(false);
    const tIdle = t0 + HOUR + 1;
    expect(store.needsContinuePrompt(tIdle)).toBe(true);

    store.rememberContinueAnswer(true, tIdle);
    expect(store.needsContinuePrompt(tIdle + 1)).toBe(false);
    // remembered answer expires after another timeoutMs from when it was given
    expect(store.needsContinuePrompt(tIdle + HOUR + 1)).toBe(true);
  });

  it("answering 'start new' via rememberContinueAnswer archives the active review immediately", () => {
    const store = new ReviewStore({ timeoutMs: HOUR });
    store.addComment(
      { path: "a.ts", startLine: 1, endLine: 1, text: "first" },
      0,
    );
    const oldId = store.getActiveReview()!.id;

    const tIdle = HOUR + 1;
    expect(store.needsContinuePrompt(tIdle)).toBe(true);
    store.rememberContinueAnswer(false, tIdle);

    expect(store.getActiveReview()).toBeNull();
    expect(store.listPastReviews().map((r) => r.id)).toContain(oldId);
  });

  it("supports a manual new review, editing, deleting comments, and deleting reviews", () => {
    const store = new ReviewStore();
    const c1 = store.addComment(
      { path: "a.ts", startLine: 1, endLine: 1, text: "first" },
      0,
    );
    store.addComment(
      { path: "b.ts", startLine: 2, endLine: 2, text: "second" },
      10,
    );
    const firstReviewId = store.getActiveReview()!.id;

    store.editComment(c1.id, { text: "edited" }, 20);
    expect(
      store.getActiveReview()!.comments.find((c) => c.id === c1.id)!.text,
    ).toBe("edited");

    store.deleteComment(c1.id, 30);
    expect(store.getActiveReview()!.comments).toHaveLength(1);

    store.startNewReview(40);
    expect(store.getActiveReview()).toBeNull();
    expect(store.listPastReviews()[0].id).toBe(firstReviewId);
    expect(store.listPastReviews()[0].archivedAt).toBe(40);

    store.addComment(
      { path: "c.ts", startLine: 3, endLine: 3, text: "third" },
      50,
    );
    const secondReviewId = store.getActiveReview()!.id;

    store.deleteReview(firstReviewId);
    expect(store.listPastReviews()).toHaveLength(0);

    store.deleteReview(secondReviewId);
    expect(store.getActiveReview()).toBeNull();
  });

  it("getReview finds the active review or a past review by id, editComment/deleteComment can target a past review", () => {
    const store = new ReviewStore();
    const c1 = store.addComment(
      { path: "a.ts", startLine: 1, endLine: 1, text: "first" },
      0,
    );
    store.startNewReview(10);
    const pastId = store.listPastReviews()[0].id;

    store.addComment(
      { path: "b.ts", startLine: 2, endLine: 2, text: "second" },
      20,
    );
    const activeId = store.getActiveReview()!.id;

    expect(store.getReview(pastId)!.id).toBe(pastId);
    expect(store.getReview(activeId)!.id).toBe(activeId);
    expect(store.getReview("missing")).toBeUndefined();

    store.editComment(c1.id, { text: "edited past" }, 30, pastId);
    expect(store.getReview(pastId)!.comments[0].text).toBe("edited past");
    // editing a past review does not touch the active review's activity clock
    expect(store.getActiveReview()!.lastActivityAt).toBe(20);

    store.deleteComment(c1.id, 40, pastId);
    expect(store.getReview(pastId)!.comments).toHaveLength(0);
  });

  it("calls onChange with a plain-JSON save change carrying only the affected review", () => {
    const changes: unknown[] = [];
    const store = new ReviewStore({
      onChange: (change) => changes.push(change),
    });
    store.addComment(
      { path: "a.ts", startLine: 1, endLine: 1, text: "first" },
      0,
    );
    expect(changes).toHaveLength(1);
    expect(JSON.parse(JSON.stringify(changes[0]))).toEqual(changes[0]);
    expect(changes[0]).toMatchObject({ kind: "save" });
  });

  it("onChange fires 'save' for comment mutations and archiving, 'delete' for deleteReview, and never for a no-op continue answer", () => {
    const changes: Array<{ kind: string }> = [];
    const store = new ReviewStore({
      onChange: (change) => changes.push(change),
    });
    store.addComment(
      { path: "a.ts", startLine: 1, endLine: 1, text: "first" },
      0,
    );
    const reviewId = store.getActiveReview()!.id;
    expect(changes).toEqual([
      { kind: "save", review: store.getActiveReview() },
    ]);

    changes.length = 0;
    store.rememberContinueAnswer(true, 10);
    expect(changes).toHaveLength(0);

    store.startNewReview(20);
    expect(changes).toEqual([
      { kind: "save", review: store.listPastReviews()[0] },
    ]);

    changes.length = 0;
    store.deleteReview(reviewId);
    expect(changes).toEqual([{ kind: "delete", reviewId }]);
  });
});
