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
  between the commit's parent and the commit, cursor on the commented line.
  When the file did not exist at the parent (added in that commit, or a root
  commit) the left-hand side is an empty document served by the extension,
  since the Git filesystem provider has none. Its context menu additionally
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

### Review guide

A second sidebar view, **Guide**, walks a branch commit by commit, with each
commit's files ranked by how closely they deserve reading. An agent (the
`/prepare-review` skill) writes the guide; the extension only displays it.

**Guide file.** JSON in `<store dir>/guides/`, any filename. The view shows the
newest (`createdAt`) guide whose `branch` is the checked-out branch, reloading
when the folder changes, when the view is shown, and on its refresh button.

```json
{ "branch": "eugene/foo", "base": "<sha>", "createdAt": 1767225600000,
  "commits": [{ "sha": "<sha>", "patchId": "<patch-id>", "subject": "…",
    "summary": "…", "flags": ["…"],
    "topics": { "auth": "…" }, "tiers": { "critical": "…" },
    "files": [{ "path": "src/a.ts", "tier": "critical", "topic": "auth", "reason": "…",
      "notes": [{ "startLine": 42, "endLine": 48, "text": "…" }] }] }] }
```

Commits are oldest first; `files` are in reading order (the first is "start
here"); tiers are `critical`, `review`, `skim`, `skip`; note lines are
1-indexed on the commit's version. A file's `topic` groups it by concern;
`topics` and `tiers` hold a short review hint per group, keyed by topic name or
tier. `flags`, `topic`, `topics`, `tiers`, `notes` and a note's `endLine` are
optional. An invalid file is listed in the view with the offending field.

**Matching.** Each guide commit is located in the branch history (`base..HEAD`,
or the last 200 commits when `base` left `HEAD`'s history) by sha, else by
`git patch-id --stable` — the same mechanism as the cursor's resync. A commit
with neither match is shown as stale.

**Tree.** Commits newest first. Under a commit, files nest by tier then topic,
or topic then tier (`vscode-reviews.guideGrouping`, toggled from the view
title); topics are left out when the commit has a single one, and files without a topic
group under "Other", last. Tiers carry a colored dot (red, yellow, gray; a
group of skips starts collapsed). A group row shows its hint, or its file count
without one. A commit row shows its short sha and checked-file progress;
its tooltip holds the summary and flags. Clicking a file opens its
parent..commit diff, on its first note. A file's reason shows on a row under
it, or after its path (`vscode-reviews.guideFileReason`, toggled from the view
title). A commit or group row opens its files
as one multi-diff editor (`vscode.changes`) in display order; a commit's skips
are left out.

**Checked files.** Files of unreviewed commits have checkboxes, persisted in
workspace state keyed by patch-id + path so they survive a rebase. Checking a
commit's last file offers **Mark reviewed**. **Toggle File Reviewed**
(`ctrl+alt+r`) flips the check of the file selected in the Guide view, or of
the guide file shown in the focused editor.

**Cursor.** The view reads `rv/<branch>`: commits up to it are reviewed
(dimmed, check icon, no checkboxes), the cursor commit gets a green bookmark,
and the view's description counts reviewed commits. Commit rows have a **Mark
reviewed** action; the view title has Resync. A cursor outside the matched
history marks nothing reviewed.

**Guide notes.** Notes render as read-only comment threads, author "Guide", on
the matching commit's version of the file (a separate comment controller with
no commenting ranges). **Add to Review** on a note copies it into the active
review as an ordinary comment and hides the note from then on. An eye button in the view
title toggles notes in diffs on and off (`vscode-reviews.guideNotesInline`).

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
- review guide — guide parsing and validation errors, nested grouping, sha /
  patch-id matching, reviewed state against the cursor, checked progress;
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
