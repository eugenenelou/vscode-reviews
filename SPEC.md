# vscode-reviews

## Problem

Reviewing a diff (a GitLens commit view, a branch compare, or just code in an
editor) produces observations that today go nowhere: there is no lightweight way
to jot line-anchored comments, keep them together as one review, and hand them
to an AI agent as actionable instructions. Copying file paths, line numbers, and
notes by hand is tedious and error-prone, and notes scattered across a session
get lost.

## Requirements

- Add a comment on a line or range in **any editor**: GitLens diff views, native
  diff views, and plain file editors.
- Comments accumulate into a single **active review**; they can be navigated,
  edited, and deleted.
- **Copy prompt**: one command copies the whole review to the clipboard in a
  token-lean text format.
- Reviews **persist** outside the repo and remain findable later; nothing is
  lost when a window closes.
- Review lifecycle is implicit — no mandatory start/stop ceremony.
- Keep it simple: no threads, no replies, no resolve states, no sharing.

## Solution

A standalone VSCode extension with three parts: inline commenting, a review
store, and a prompt exporter.

### Commenting

Native VSCode Comment API: hover a gutter, click "+", type. The inline widget
provides edit and delete. Commenting is available in every editor — no URI
filtering. In a diff view, comments anchor to the **new (right-hand) side**;
deleted-line (left-side) comments are out of scope for now.

Each comment stores: repo-relative file path, line or line range, the short
commit sha when the annotated document is a committed version from a diff view
(GitLens or native), and the comment text.

### Review lifecycle

One implicit active review per workspace:

- First comment auto-creates a review; subsequent comments append.
- **Idle timeout** (default 1 hour, configurable): when a comment is added and
  the active review has been idle longer than the timeout, ask whether to
  continue it or start a new one. The answer is remembered for the same
  duration, so the question fires once per gap, not once per comment. Any
  comment activity refreshes the idle clock.
- A manual "New review" command closes the active review and starts fresh.

### Sidebar

A dedicated view:

- **Active review** on top: comments listed as `file — line — excerpt`; click
  jumps to the location; inline edit/delete; review-level actions: Copy prompt,
  New review, Delete review.
- **Past reviews** below, collapsed: previous reviews by date, expandable to the
  same comment list, each with its own Copy prompt and Delete.

### Prompt format

Copied to the clipboard as plain text, optimized for tokens. One entry per
comment: the location line, then the comment text; entries separated by `---`.
Location is `path:line` (or `path:start-end` for ranges), with `@<short-sha>`
appended when the comment was made on a committed version in a diff view:

```
src/foo/bar.py:42@abc1234
this copies the list for nothing
---
src/services/sync.py:88-91
extract this into a helper
```

### Storage

Reviews are JSON in the extension's per-workspace storage (outside the repo).
No gitignore edits, no repo pollution; the sidebar's past-reviews list is the
retrieval path.

## Testing decisions

One mechanical seam: the pure core module (no VSCode APIs), unit-tested with
vitest:

- review lifecycle — auto-create, append, idle timeout and the remembered
  continue/new answer, with an injected clock;
- prompt formatting — separator, ranges, `@sha` suffix presence;
- URI parsing — GitLens/native-diff URI → repo-relative path + short sha.

VSCode wiring (Comment API, sidebar tree, clipboard) is verified manually; no
`@vscode/test-electron` harness at prototype stage.

## Out of scope

- Comments on deleted (left-side) diff lines.
- Threads, replies, resolve states, multi-user sharing.
- Exporting reviews as files (can be added later if needed).
- Cross-machine sync of stored reviews.

<details>
<summary>Appendix: discarded options</summary>

- **One review per diff context, auto-keyed by commit/range** — rejected for an
  explicit-but-implicit single active review; the user reviews across contexts
  in one session.
- **Age-since-creation timeout** — rejected for idle time; a long active session
  is still one review, only a real gap should trigger the question.
- **Command + input-box commenting UX** — rejected; native Comment API gives
  inline visibility and free edit/delete.
- **Rich prompt format with code snippets** — rejected; token-lean
  `path:line` + text is enough for an agent working in the same tree.
- **Storing reviews in a repo folder (e.g. `.reviews/`)** — rejected; extension
  workspace storage avoids gitignore edits and tree clutter.
- **Restricting commenting to GitLens diff views only** — rejected; allowing
  every editor is less code and more useful.

</details>
