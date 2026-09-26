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

- **Active review** on top: comments listed as `file — line — excerpt`. A
  comment made on a plain file (no sha) opens that file on click. A comment
  made on a committed diff version opens, on click, a diff of the file
  between the commit's parent and the commit, cursor on the commented line —
  or, when the file did not exist at the parent (added in that commit, or a
  root commit), just the file at that revision, since the Git filesystem
  provider has no left-hand document to serve. Its context menu additionally
  offers **Open File at Revision** (the file
  read-only, as of that commit) and **Open Current File** (the working-tree
  file, at the stored line — which may have drifted since the comment was
  made). Inline edit/delete; review-level actions: Copy prompt, New review,
  Delete review.
- **Past reviews** below, collapsed: previous reviews by date, expandable to the
  same comment list, each with its own Copy prompt and Delete.

### Review cursor

A per-branch lightweight git tag `rv/<branch>` marks the last commit reviewed
on the branch checked out in the commit's repo (`git rev-parse --abbrev-ref
HEAD`; detached `HEAD` → error, nothing done). GitLens renders tags before
commit messages in its commit views, so the tag is the cursor — no GitLens API,
no tree decoration.

- **Mark reviewed** runs `git tag -f rv/<branch> <sha>`, from two entry points:
  a context-menu item on GitLens commit rows (`viewItem =~
  /^gitlens:commit\b/`; sha and repo read from the node's `commit.sha` /
  `commit.repoPath`), and a Reviews view title button marking `HEAD` of the
  workspace repo's current branch.
- **Resync** (Reviews view title button), for the workspace repo's current
  branch: no tag → info; tag is an ancestor of `HEAD` → up to date; otherwise
  the tagged commit's `git patch-id --stable` is matched against those of
  `git log -p --no-merges rv/<branch>..HEAD`, and the tag moves to the match,
  or a warning asks to re-mark manually. No watchers, no stored state, no
  automatic resync.

Caveats: `git push --tags` publishes `rv/` tags; resync only matches when the
marked commit's own diff is unchanged by the rewrite.

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
- review cursor — tag name, patch-id output parsing and matching, GitLens
  commit-node shape;
- URI parsing — GitLens/native-diff URI → repo-relative path + short sha;
  the revision-URI round-trip (`buildRevisionUri` ↔ `parseLocation`) is
  unit-tested to pin that both agree on the same URI shape.

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
