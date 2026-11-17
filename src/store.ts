// store.ts — the forge's in-memory state: repositories, git objects, refs,
// issues, pull requests, labels and comments. No persistence: one trial run
// is one process, and the suite never restarts the entry mid-trial.

import { Buffer } from 'node:buffer';
import {
  ZERO_OID,
  buildCommit,
  buildTree,
  collectReachable,
  hashObject,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './git-core.ts';

/** The viewer the bearer token names (the scenario's seeded viewer; the token is opaque). */
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const VIEWER_IDENTITY = `${VIEWER_NAME} <${VIEWER_EMAIL}>`;
export const DEFAULT_BRANCH = 'main';

/** Deterministic clock: a fixed epoch plus a monotonic sequence, so two runs agree. */
const EPOCH_SEC = 1735689600; // 2025-01-01T00:00:00Z
const EPOCH_MS = EPOCH_SEC * 1000;

export interface Label {
  name: string;
  color: string;
}

export interface IssueComment {
  id: number;
  body: string;
  createdSeq: number;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: IssueComment[];
  createdSeq: number;
  updatedSeq: number;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  createdSeq: number;
  updatedSeq: number;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdSeq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: PullRequest[];
  nextIssueNumber: number;
  nextPullNumber: number;
  nextCommentId: number;
}

export class Forge {
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 5000;
  private nextObjectId = 10000;
  private seq = 0;

  /** A deterministic timestamp string; each call advances one second. */
  timestamp(): { sec: number; iso: string } {
    const sec = EPOCH_SEC + this.seq;
    this.seq += 1;
    return { sec, iso: new Date(EPOCH_MS + (sec - EPOCH_SEC) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') };
  }

  /** The current sequence value (for ordering), without advancing it. */
  nowSeq(): number {
    return this.seq;
  }

  advanceSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  /** The viewer's own repositories, in creation order. */
  userRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo {
    const repo: Repo = {
      id: this.nextRepoId++,
      name,
      owner,
      description,
      private: isPrivate,
      defaultBranch: DEFAULT_BRANCH,
      createdSeq: this.seq++,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      nextIssueNumber: 1,
      nextPullNumber: 1,
      nextCommentId: 1,
    };
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  // -------------------------------------------------------------------------------------------
  // git objects
  // -------------------------------------------------------------------------------------------

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  lookup(repo: Repo): (oid: string) => GitObject | undefined {
    return (oid) => repo.objects.get(oid);
  }

  refTip(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  /** Resolve a ref name, branch name or oid to a commit oid (peeling tags). */
  resolveRef(repo: Repo, ref: string): string | undefined {
    let oid: string | undefined;
    if (ref.startsWith('refs/')) oid = repo.refs.get(ref);
    else if (repo.refs.has(`refs/heads/${ref}`)) oid = repo.refs.get(`refs/heads/${ref}`);
    else if (repo.refs.has(`refs/tags/${ref}`)) oid = repo.refs.get(`refs/tags/${ref}`);
    else if (isObjectId(ref)) oid = ref;
    if (oid === undefined || oid === ZERO_OID) return undefined;
    return this.peelToCommit(repo, oid);
  }

  /** Follow tag objects to the commit they point at. */
  peelToCommit(repo: Repo, oid: string): string | undefined {
    let current = oid;
    for (let hops = 0; hops < 10; hops += 1) {
      const object = repo.objects.get(current);
      if (!object) return undefined;
      if (object.type === 'commit') return current;
      if (object.type === 'tag') {
        current = parseTag(object.data).object;
        continue;
      }
      return undefined;
    }
    return undefined;
  }

  /** The commit a tag ref peels to (for ls-refs `peeled:`). */
  peelRef(repo: Repo, refOid: string): string | undefined {
    const object = repo.objects.get(refOid);
    if (!object || object.type !== 'tag') return undefined;
    return this.peelToCommit(repo, parseTag(object.data).object);
  }

  /** True when `ancestor` is reachable from `descendant` (following first and later parents). */
  isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const seen = new Set<string>();
    const queue = [descendant];
    while (queue.length) {
      const oid = queue.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) {
        if (parent === ancestor) return true;
        queue.push(parent);
      }
    }
    return false;
  }

  /** The merge-base of two commits: the newest common ancestor by commit time. */
  mergeBase(repo: Repo, a: string, b: string): string | undefined {
    const ancestorsA = new Map<string, number>();
    const queueA: string[] = [a];
    while (queueA.length) {
      const oid = queueA.pop()!;
      if (ancestorsA.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      const commit = parseCommit(object.data);
      ancestorsA.set(oid, commitTimestamp(commit));
      for (const parent of commit.parents) queueA.push(parent);
    }
    let best: string | undefined;
    let bestTime = -1;
    const queueB: string[] = [b];
    const seenB = new Set<string>();
    while (queueB.length) {
      const oid = queueB.pop()!;
      if (seenB.has(oid)) continue;
      seenB.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      const commit = parseCommit(object.data);
      const timeA = ancestorsA.get(oid);
      if (timeA !== undefined && timeA > bestTime) {
        best = oid;
        bestTime = timeA;
      }
      for (const parent of commit.parents) queueB.push(parent);
    }
    return best;
  }

  /** All commits reachable from `tip`, newest first (by timestamp, then insertion order). */
  commitHistory(repo: Repo, tip: string | undefined): string[] {
    if (tip === undefined || tip === ZERO_OID) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    const queue: string[] = [tip];
    while (queue.length) {
      // Pop the newest commit first.
      let bestIndex = 0;
      let bestTime = -1;
      for (let i = 0; i < queue.length; i += 1) {
        const object = repo.objects.get(queue[i]!);
        if (!object || object.type !== 'commit') continue;
        const time = commitTimestamp(parseCommit(object.data));
        if (time > bestTime) {
          bestTime = time;
          bestIndex = i;
        }
      }
      const oid = queue.splice(bestIndex, 1)[0]!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      out.push(oid);
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    return out;
  }

  /** Flatten a tree into path -> {oid, mode}, following directories. */
  flattenTree(repo: Repo, treeOid: string): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (tree: string, prefix: string): void => {
      const object = repo.objects.get(tree);
      if (!object || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** Diff two trees: one entry per changed path, with line counts for blobs. */
  diffTrees(repo: Repo, baseTree: string, headTree: string): Array<{
    path: string;
    status: 'added' | 'modified' | 'removed';
    oldOid: string | null;
    newOid: string | null;
    additions: number;
    deletions: number;
  }> {
    const base = this.flattenTree(repo, baseTree);
    const head = this.flattenTree(repo, headTree);
    const paths = new Set([...base.keys(), ...head.keys()]);
    const out: Array<{
      path: string;
      status: 'added' | 'modified' | 'removed';
      oldOid: string | null;
      newOid: string | null;
      additions: number;
      deletions: number;
    }> = [];
    for (const path of [...paths].sort()) {
      const b = base.get(path);
      const h = head.get(path);
      if (b && !h) {
        const oldText = repo.objects.get(b.oid)?.data.toString('utf8') ?? '';
        out.push({ path, status: 'removed', oldOid: b.oid, newOid: null, additions: 0, deletions: countLines(oldText) });
      } else if (!b && h) {
        const newText = repo.objects.get(h.oid)?.data.toString('utf8') ?? '';
        out.push({ path, status: 'added', oldOid: null, newOid: h.oid, additions: countLines(newText), deletions: 0 });
      } else if (b && h && b.oid !== h.oid) {
        const oldText = repo.objects.get(b.oid)?.data.toString('utf8') ?? '';
        const newText = repo.objects.get(h.oid)?.data.toString('utf8') ?? '';
        const { additions, deletions } = lineDiff(oldText, newText);
        out.push({ path, status: 'modified', oldOid: b.oid, newOid: h.oid, additions, deletions });
      }
    }
    return out;
  }

  /** The three-way mergeability of a head branch against a base tip. */
  mergeable(repo: Repo, baseTip: string, headTip: string): 'MERGEABLE' | 'CONFLICTING' {
    const baseCommit = repo.objects.get(baseTip);
    const headCommit = repo.objects.get(headTip);
    if (!baseCommit || !headCommit) return 'CONFLICTING';
    const mergeBaseOid = this.mergeBase(repo, baseTip, headTip);
    if (mergeBaseOid === undefined) return 'CONFLICTING';
    const baseTree = parseCommit(repo.objects.get(mergeBaseOid)!.data).tree;
    const baseFlat = this.flattenTree(repo, baseTree);
    const tipFlat = this.flattenTree(repo, parseCommit(baseCommit.data).tree);
    const headFlat = this.flattenTree(repo, parseCommit(headCommit.data).tree);
    const paths = new Set([...baseFlat.keys(), ...tipFlat.keys(), ...headFlat.keys()]);
    for (const path of paths) {
      const b = baseFlat.get(path)?.oid ?? null;
      const t = tipFlat.get(path)?.oid ?? null;
      const h = headFlat.get(path)?.oid ?? null;
      const baseChanged = t !== b;
      const headChanged = h !== b;
      if (baseChanged && headChanged && t !== h) return 'CONFLICTING';
    }
    return 'MERGEABLE';
  }

  /** Squash-merge a pull request onto its base branch. Returns the merge commit oid, or null on conflict. */
  squashMerge(repo: Repo, pull: PullRequest): string | null {
    const baseTip = repo.refs.get(`refs/heads/${pull.base.ref}`);
    const headTip = repo.refs.get(`refs/heads/${pull.head.ref}`);
    if (baseTip === undefined || headTip === undefined) return null;
    if (this.mergeable(repo, baseTip, headTip) === 'CONFLICTING') return null;
    const headCommit = repo.objects.get(headTip);
    if (!headCommit || headCommit.type !== 'commit') return null;
    const headTree = parseCommit(headCommit.data).tree;
    const { sec } = this.timestamp();
    const message = `${pull.title} (#${pull.number})\n`;
    const commitData = buildCommit({
      tree: headTree,
      parents: [baseTip],
      message,
      author: VIEWER_IDENTITY,
      committer: VIEWER_IDENTITY,
      timestamp: sec,
    });
    const mergeOid = this.putObject(repo, 'commit', commitData);
    repo.refs.set(`refs/heads/${pull.base.ref}`, mergeOid);
    return mergeOid;
  }

  // -------------------------------------------------------------------------------------------
  // contents API: commit one file on a branch
  // -------------------------------------------------------------------------------------------

  /**
   * Commit `content` at `path` on `branch` (creating the branch from the default branch tip
   * when it does not exist yet, and creating the repository's first commit when unborn).
   * Returns the commit oid and blob oid.
   */
  commitFile(
    repo: Repo,
    branch: string,
    path: string,
    content: Buffer,
    message: string,
  ): { commitOid: string; blobOid: string } {
    const blobOid = this.putObject(repo, 'blob', content);
    const segments = path.split('/').filter((s) => s !== '');
    const branchRef = `refs/heads/${branch}`;
    const parentTip = repo.refs.get(branchRef) ?? repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    const parentTree = parentTip === undefined ? null : parseCommit(repo.objects.get(parentTip)!.data).tree;
    const newTree = this.treeWithPath(repo, parentTree, segments, blobOid);
    const { sec } = this.timestamp();
    const commitData = buildCommit({
      tree: newTree,
      parents: parentTip === undefined ? [] : [parentTip],
      message: message.endsWith('\n') ? message : `${message}\n`,
      author: VIEWER_IDENTITY,
      committer: VIEWER_IDENTITY,
      timestamp: sec,
    });
    const commitOid = this.putObject(repo, 'commit', commitData);
    repo.refs.set(branchRef, commitOid);
    return { commitOid, blobOid };
  }

  /**
   * A new tree oid with `segments` set to `blobOid`, every other entry kept.
   * Creates intermediate directories as needed.
   */
  treeWithPath(repo: Repo, treeOid: string | null, segments: readonly string[], blobOid: string): string {
    const head = segments[0]!;
    const rest = segments.slice(1);
    const entries: TreeEntry[] = treeOid === null ? [] : parseTree(repo.objects.get(treeOid)!.data);
    const kept = entries.filter((entry) => entry.name !== head);
    if (rest.length === 0) {
      kept.push({ mode: '100644', name: head, oid: blobOid });
    } else {
      const existing = entries.find((entry) => entry.name === head && entry.mode === '40000');
      const childTree = existing === undefined ? null : existing.oid;
      kept.push({ mode: '40000', name: head, oid: this.treeWithPath(repo, childTree, rest, blobOid) });
    }
    return this.putObject(repo, 'tree', buildTree(kept));
  }

  /** Remove `path` from `branch`'s tree and commit the deletion. */
  deleteFile(repo: Repo, branch: string, path: string, message: string): { commitOid: string } | null {
    const branchRef = `refs/heads/${branch}`;
    const tip = repo.refs.get(branchRef);
    if (tip === undefined) return null;
    const segments = path.split('/').filter((s) => s !== '');
    const parentTree = parseCommit(repo.objects.get(tip)!.data).tree;
    const newTree = this.treeWithoutPath(repo, parentTree, segments);
    if (newTree === null) return null;
    const { sec } = this.timestamp();
    const commitData = buildCommit({
      tree: newTree,
      parents: [tip],
      message: message.endsWith('\n') ? message : `${message}\n`,
      author: VIEWER_IDENTITY,
      committer: VIEWER_IDENTITY,
      timestamp: sec,
    });
    const commitOid = this.putObject(repo, 'commit', commitData);
    repo.refs.set(branchRef, commitOid);
    return { commitOid };
  }

  /** A new tree oid with `segments` removed; null when the path does not exist. */
  private treeWithoutPath(repo: Repo, treeOid: string, segments: readonly string[]): string | null {
    const head = segments[0]!;
    const rest = segments.slice(1);
    const entries = parseTree(repo.objects.get(treeOid)!.data);
    const target = entries.find((entry) => entry.name === head);
    if (!target) return null;
    if (rest.length === 0) {
      const kept = entries.filter((entry) => entry.name !== head);
      return this.putObject(repo, 'tree', buildTree(kept));
    }
    if (target.mode !== '40000') return null;
    const child = this.treeWithoutPath(repo, target.oid, rest);
    if (child === null) return null;
    const kept = entries.filter((entry) => entry.name !== head);
    kept.push({ mode: '40000', name: head, oid: child });
    return this.putObject(repo, 'tree', buildTree(kept));
  }

  /** Read a file (or directory listing) at `path` on the given ref. */
  readPath(
    repo: Repo,
    ref: string | undefined,
    path: string,
  ):
    | { kind: 'file'; oid: string; data: Buffer; mode: string }
    | { kind: 'dir'; entries: Array<{ name: string; path: string; oid: string; type: 'file' | 'dir' }> }
    | null {
    const tip = ref === undefined ? repo.refs.get(`refs/heads/${repo.defaultBranch}`) : this.resolveRef(repo, ref);
    if (tip === undefined) return null;
    const treeOid = parseCommit(repo.objects.get(tip)!.data).tree;
    const segments = path.split('/').filter((s) => s !== '');
    if (segments.length === 0) {
      return { kind: 'dir', entries: this.dirEntries(repo, treeOid, '') };
    }
    let currentTree = treeOid;
    for (let i = 0; i < segments.length; i += 1) {
      const entries = parseTree(repo.objects.get(currentTree)!.data);
      const entry = entries.find((e) => e.name === segments[i]);
      if (!entry) return null;
      const isLast = i === segments.length - 1;
      if (entry.mode === '40000') {
        if (isLast) return { kind: 'dir', entries: this.dirEntries(repo, entry.oid, segments.join('/')) };
        currentTree = entry.oid;
      } else {
        if (!isLast) return null;
        const object = repo.objects.get(entry.oid);
        if (!object) return null;
        return { kind: 'file', oid: entry.oid, data: object.data, mode: entry.mode };
      }
    }
    return null;
  }

  private dirEntries(
    repo: Repo,
    treeOid: string,
    prefix: string,
  ): Array<{ name: string; path: string; oid: string; type: 'file' | 'dir' }> {
    const object = repo.objects.get(treeOid);
    if (!object || object.type !== 'tree') return [];
    return parseTree(object.data).map((entry) => ({
      name: entry.name,
      path: prefix === '' ? entry.name : `${prefix}/${entry.name}`,
      oid: entry.oid,
      type: entry.mode === '40000' ? ('dir' as const) : ('file' as const),
    }));
  }

  // -------------------------------------------------------------------------------------------
  // issues and pull requests
  // -------------------------------------------------------------------------------------------

  createIssue(repo: Repo, title: string, body: string, labels: Label[]): Issue {
    const issue: Issue = {
      id: this.nextObjectId++,
      number: repo.nextIssueNumber++,
      title,
      body,
      state: 'open',
      labels: [...labels],
      comments: [],
      createdSeq: this.seq++,
      updatedSeq: this.seq,
    };
    repo.issues.push(issue);
    return issue;
  }

  createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string): PullRequest | null {
    const headTip = repo.refs.get(`refs/heads/${headRef}`);
    const baseTip = repo.refs.get(`refs/heads/${baseRef}`);
    if (headTip === undefined || baseTip === undefined) return null;
    const pull: PullRequest = {
      id: this.nextObjectId++,
      number: repo.nextPullNumber++,
      title,
      body,
      state: 'open',
      head: { ref: headRef, sha: headTip },
      base: { ref: baseRef, sha: baseTip },
      merged: false,
      merged_at: null,
      merge_commit_sha: null,
      createdSeq: this.seq++,
      updatedSeq: this.seq,
    };
    repo.pulls.push(pull);
    return pull;
  }

  reachable(repo: Repo, roots: Iterable<string>): Set<string> {
    return collectReachable(roots, this.lookup(repo), { allowMissing: true });
  }
}

/** The author/committer timestamp inside a commit's header line. */
export function commitTimestamp(commit: CommitView): number {
  const match = / (\d+) [+-]\d{4}$/.exec(commit.author);
  return match ? Number(match[1]) : 0;
}

/** Number of lines in a text (a trailing newline does not make an extra line). */
export function countLines(text: string): number {
  if (text === '') return 0;
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

/** A small LCS line diff: additions and deletions between two texts. */
export function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  if (oldLines[oldLines.length - 1] === '') oldLines.pop();
  if (newLines[newLines.length - 1] === '') newLines.pop();
  const n = oldLines.length;
  const m = newLines.length;
  // LCS lengths, computed row by row to keep memory small.
  let prev = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i += 1) {
    const cur = new Array<number>(m + 1).fill(0);
    for (let j = 1; j <= m; j += 1) {
      cur[j] = oldLines[i - 1] === newLines[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, cur[j - 1]!);
    }
    prev = cur;
  }
  const lcs = prev[m]!;
  return { additions: m - lcs, deletions: n - lcs };
}
