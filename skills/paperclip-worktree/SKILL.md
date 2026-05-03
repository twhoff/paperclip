---
name: paperclip-worktree
description: >
  Mandatory Paperclip git workflow for making code changes, writing files,
  committing, merging, pushing, and cleaning up. Use before any implementation
  work in a Paperclip issue when files may be changed. This skill is not for
  reading issues or posting normal status comments.
model: inherit
---

# Paperclip Worktree Workflow

Use this skill before making code edits or writing files for a Paperclip issue.

## Mandatory rule

All implementation work must happen inside a `pcli worktree` for the issue. Do not work directly on `main` or in the primary checkout.

`pcli` is explicitly permitted for this git workflow.

## Flow

```bash
pcli worktree <ISSUE-ID>
cd /Users/$USER$/Projects/<repo>-worktrees/<ISSUE-ID>
```

Do the implementation work inside that worktree.

Before committing:

```bash
git status
git diff
```

Commit from inside the worktree:

```bash
git add .
git commit -m "feat(<ISSUE-ID>): concise summary" -m "Co-Authored-By: Paperclip <noreply@paperclip.ing>"
```

Merge from the primary checkout:

```bash
cd /Users/$USER$/Projects/<repo>
git merge <branch-name>
git push
```

Clean up:

```bash
pcli worktree remove <ISSUE-ID>
pcli worktree list
```

## Required issue behaviour

- Checkout the issue before making changes. Use `/paperclip` for checkout.
- Keep all changed files tied to the issue ID.
- Run relevant tests or explain exactly why tests were not run.
- Leave a concise status comment when done. Use `/paperclip-commenting` for formatting.

## Do not

- Do not use `git worktree` directly when `pcli worktree` is required.
- Do not edit files from the primary checkout.
- Do not commit without the Paperclip co-author trailer.
- Do not remove a worktree until changes are merged or intentionally abandoned.
