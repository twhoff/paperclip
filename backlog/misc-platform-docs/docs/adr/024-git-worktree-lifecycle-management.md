---
title: Git Worktree Lifecycle Management
description: Establishes the policy for how agents create, manage, and clean up git worktrees — ensuring worktrees are session-scoped, never left stale, and always in a predictable state.
created: 2026-03-22
updated: 2026-04-06
status: accepted
number: 24
tags: [engineering, git, dx, conventions, agents]
related: [adr/010-general-engineering-best-practices]
authors: [CEO]
accepted_by: [Lead Engineer]
---

# ADR-024: Git Worktree Lifecycle Management

**Status:** Accepted
**Date:** 2026-03-22
**Updated:** 2026-04-06

## Context

Multiple agents work in the same repository concurrently. Git worktrees provide isolation — each agent works in its own directory without interfering with others. The workflow must be simple: one short-lived branch per issue, no PRs, no merge gates.

## Decision

### Core Principle

**Worktrees are session-scoped.** One task = one worktree. `pcli worktree` creates a short-lived branch named after the issue ID (e.g. `tiza-439`) based on `main`. Agents commit on this branch, then merge to `main` and push. No pull requests.

### Worktree Creation

- Create a worktree **only** when starting an assigned task that requires code changes.
- The worktree MUST be named after the Issue ID (e.g. `TIZA-439`).
- Use a predictable sibling location:
  ```
  <repo-parent>/<repo>-worktrees/<ISSUE-ID>
  ```
  Example: `/Users/twhoffmann/Projects/tizzi-app-worktrees/TIZA-439`
- **The worktree MUST be a sibling directory to the repository root, not a child.** Creating a worktree inside the repository directory is forbidden.
- **`pcli worktree` creates an issue-named branch** (e.g. `tiza-439`) based on `main`. Agents commit on this branch, then merge to `main` in the primary checkout before pushing.
- ⛔ **NEVER run `git worktree add`, `git worktree remove`, or any raw `git worktree` subcommand.** All worktree operations MUST go through `pcli worktree` which handles naming, location, branch setup, and session state correctly.

```bash
pcli worktree <ISSUE-ID>              # Create worktree
pcli worktree remove <ISSUE-ID>       # Remove worktree
pcli worktree list                     # List active worktrees
pcli worktree clean                    # Remove merged/stale worktrees
```

### Session Lifecycle

Every agent session that uses a worktree must end in one of two clean states:

#### State A: Work Complete — Commit, Merge, Push, Remove

1. Commit all changes on the issue branch in the worktree.
2. In the primary checkout, merge the worktree's branch: `cd <primary> && git merge <worktree-branch>`
3. Push to origin: `git push`
4. Remove the worktree: `pcli worktree remove <ISSUE-ID>`

**A task is only `done` after a successful push.** Never mark a task as done before pushing.

#### State B: Work Incomplete — Commit and Remove

1. **Commit all current work** with a WIP message: `wip(TIZA-439): <brief description>`
2. Remove the worktree: `pcli worktree remove <ISSUE-ID>`
3. **Do not delete the branch.** It persists for the next session.
4. Update the task comment to note current progress.

### What Never Goes on `main` Incomplete

- Code that breaks the build
- Failing tests
- Schema migrations without corresponding application code

### Write-Blocking Enforcement

A **pre-tool-use write-blocking guard** intercepts all write operations in the primary repository checkout and rejects them if the agent is not inside a worktree. Policy without enforcement is just a suggestion.

### No Pull Requests

PRs are not used. They create bottlenecks in a multi-agent workflow. Agents commit on their issue branch within the worktree, merge to `main`, and push.

### Stale Worktree Definition

A worktree is stale if:

- The associated task is `done` or `cancelled`
- No commits have been made in >7 days
- The branch has been merged into `main`

Stale worktrees must be removed promptly.

## Consequences

**Positive:**

- Simple workflow: commit → merge → push → done
- No PR bottleneck — agents ship continuously
- Agents can see in-flight work with `pcli worktree list`
- Primary worktree always on `main` in a known-good state

**Negative:**

- No pre-merge review gate — quality relies on tests and post-merge review
- Merge conflicts possible when multiple agents push to `main` concurrently — resolved by pull-before-push
