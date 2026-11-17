// rest.ts — the GitHub REST v3 surface under /api/v3.
// Every reply is application/json with an X-GitHub-Request-Id; unknown routes
// are JSON 404s; malformed JSON bodies are 400s; no token is a 401.

import { Buffer } from 'node:buffer';
import { parseCommit } from './git-core.ts';
import {
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  type Forge,
  type Issue,
  type PullRequest,
  type Repo,
} from './store.ts';

export interface RestResult {
  status: number;
  body: unknown; // JSON value, or null for an empty (204) reply
}

export interface RestRequest {
  method: string;
  /** Decoded path segments, without the /api/v3 prefix. */
  segments: string[];
  /** Query parameters. */
  query: URLSearchParams;
  /** Parsed JSON body (undefined when no body was sent). */
  body: unknown;
  /** True when the body was present but not valid JSON. */
  bodyMalformed: boolean;
  /** The request's origin, for absolute pagination links. */
  origin: string;
}

function ok(body: unknown, status = 200): RestResult {
  return { status, body };
}

function err(status: number, message: string): RestResult {
  return { status, body: { message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

// ---------------------------------------------------------------------------------------------
// shapes
// ---------------------------------------------------------------------------------------------

export function repoJson(repo: Repo, origin: string): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER_ID : 0, type: 'User' },
    private: repo.private,
    html_url: `${origin}/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: isoOf(repo.createdSeq),
    updated_at: isoOf(repo.createdSeq),
    pushed_at: isoOf(repo.createdSeq),
    default_branch: repo.defaultBranch,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
  };
}

function isoOf(seq: number): string {
  return new Date(1735689600000 + seq * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** The date embedded in a git identity string (`Name <email> <epoch> +0000`). */
function identityDate(identity: string): string {
  const match = /(\d{10,}) \+0000$/.exec(identity.trim());
  if (!match) return isoOf(0);
  return new Date(Number(match[1]) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function issueJson(issue: Issue, repo: Repo): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    labels: issue.labels.map((label) => ({ name: label.name, color: label.color })),
    comments: issue.comments.length,
    created_at: isoOf(issue.createdSeq),
    updated_at: isoOf(issue.updatedSeq),
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

export function pullJson(pull: PullRequest, repo: Repo): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: `PR_${pull.id}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    head: { ref: pull.head.ref, sha: pull.head.sha, label: `${repo.owner}:${pull.head.ref}` },
    base: { ref: pull.base.ref, sha: pull.base.sha, label: `${repo.owner}:${pull.base.ref}` },
    merged: pull.merged,
    merged_at: pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha,
    mergeable: null,
    created_at: isoOf(pull.createdSeq),
    updated_at: isoOf(pull.updatedSeq),
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

// ---------------------------------------------------------------------------------------------
// pagination
// ---------------------------------------------------------------------------------------------

interface PageParams {
  page: number;
  perPage: number;
}

function pageParams(query: URLSearchParams): PageParams {
  const perPageRaw = Number.parseInt(query.get('per_page') ?? '', 10);
  const pageRaw = Number.parseInt(query.get('page') ?? '', 10);
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, perPageRaw) : 30;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  return { page, perPage };
}

function paginate<T>(items: readonly T[], params: PageParams): { page: T[]; totalPages: number } {
  const totalPages = Math.max(1, Math.ceil(items.length / params.perPage));
  const start = (params.page - 1) * params.perPage;
  return { page: items.slice(start, start + params.perPage), totalPages };
}

/** A GitHub-style Link header for a paginated list, or null when there is one page. */
function linkHeader(origin: string, path: string, query: URLSearchParams, params: PageParams, totalPages: number): string | null {
  if (totalPages <= 1) return null;
  const urlFor = (page: number): string => {
    const q = new URLSearchParams(query);
    q.set('page', String(page));
    q.set('per_page', String(params.perPage));
    return `${origin}${path}?${q.toString()}`;
  };
  const links: string[] = [];
  if (params.page < totalPages) links.push(`<${urlFor(params.page + 1)}>; rel="next"`);
  if (params.page > 1) links.push(`<${urlFor(params.page - 1)}>; rel="prev"`);
  links.push(`<${urlFor(1)}>; rel="first"`);
  links.push(`<${urlFor(totalPages)}>; rel="last"`);
  return links.join(', ');
}

// ---------------------------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------------------------

/** The handler's extra output: response headers beyond the JSON defaults. */
export interface RestOutcome {
  result: RestResult;
  headers?: Record<string, string>;
}

export function handleRest(forge: Forge, req: RestRequest): RestOutcome {
  const { method, segments } = req;
  if (req.bodyMalformed) return { result: err(400, 'Problems parsing JSON') };

  // GET /api/v3/
  if (segments.length === 0) {
    if (method !== 'GET') return { result: err(404, 'Not Found') };
    return {
      result: ok({
        current_user_url: `${req.origin}/api/v3/user`,
        repository_url: `${req.origin}/api/v3/repos/{owner}/{repo}`,
        rate_limit_url: `${req.origin}/api/v3/rate_limit`,
      }),
      headers: { 'x-oauth-scopes': 'repo, read:user' },
    };
  }

  if (segments[0] === 'meta' && segments.length === 1) {
    if (method !== 'GET') return { result: err(404, 'Not Found') };
    return { result: ok({ installed_version: '1.0.0', verifiable_password_authentication: true }) };
  }

  if (segments[0] === 'user') {
    if (segments.length === 1) {
      if (method !== 'GET') return { result: err(404, 'Not Found') };
      return { result: ok({ login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, type: 'User' }) };
    }
    if (segments[1] === 'repos') {
      if (method === 'POST') return { result: createUserRepo(forge, req) };
      if (method === 'GET') return listUserRepos(forge, req);
      return { result: err(404, 'Not Found') };
    }
    return { result: err(404, 'Not Found') };
  }

  if (segments[0] !== 'repos' || segments.length < 3) return { result: err(404, 'Not Found') };
  const owner = segments[1]!;
  const repoName = segments[2]!;
  const repo = forge.getRepo(owner, repoName);
  // A repository belongs to the token's login; any other owner is a 404, never a 403.
  if (owner !== VIEWER_LOGIN || repo === undefined) return { result: err(404, 'Not Found') };
  const rest = segments.slice(3);

  if (rest.length === 0) {
    if (method === 'GET') return { result: ok(repoJson(repo, req.origin)) };
    if (method === 'PATCH') return { result: patchRepo(forge, repo, req) };
    if (method === 'DELETE') {
      forge.deleteRepo(owner, repoName);
      return { result: { status: 204, body: null } };
    }
    return { result: err(404, 'Not Found') };
  }

  switch (rest[0]) {
    case 'branches':
      return handleBranches(forge, repo, req, rest.slice(1));
    case 'commits':
      return handleCommits(forge, repo, req, rest.slice(1));
    case 'git':
      return handleGitRefs(forge, repo, req, rest.slice(1));
    case 'contents':
      return handleContents(forge, repo, req, rest.slice(1));
    case 'labels':
      return handleLabels(forge, repo, req, rest.slice(1));
    case 'issues':
      return handleIssues(forge, repo, req, rest.slice(1));
    case 'pulls':
      return handlePulls(forge, repo, req, rest.slice(1));
    default:
      return { result: err(404, 'Not Found') };
  }
}

// ---------------------------------------------------------------------------------------------
// repositories
// ---------------------------------------------------------------------------------------------

function createUserRepo(forge: Forge, req: RestRequest): RestResult {
  const body = isRecord(req.body) ? req.body : {};
  const name = asString(body.name);
  if (name === '') return err(422, 'name is required');
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return err(422, 'name is invalid');
  if (forge.getRepo(VIEWER_LOGIN, name) !== undefined) return err(422, 'name already exists on this account');
  const repo = forge.createRepo(VIEWER_LOGIN, name, asString(body.description), asBool(body.private, false));
  return ok(repoJson(repo, req.origin), 201);
}

function listUserRepos(forge: Forge, req: RestRequest): RestOutcome {
  const params = pageParams(req.query);
  const repos = forge.userRepos(VIEWER_LOGIN);
  const { page, totalPages } = paginate(repos, params);
  const link = linkHeader(req.origin, '/api/v3/user/repos', req.query, params, totalPages);
  return {
    result: ok(page.map((repo) => repoJson(repo, req.origin))),
    headers: link === null ? undefined : { link },
  };
}

function patchRepo(forge: Forge, repo: Repo, req: RestRequest): RestResult {
  const body = isRecord(req.body) ? req.body : {};
  if (typeof body.description === 'string') repo.description = body.description;
  if (typeof body.name === 'string' && body.name !== '' && body.name !== repo.name) {
    if (forge.getRepo(repo.owner, body.name) !== undefined) return err(422, 'name already exists on this account');
    forge.repos.delete(forge.key(repo.owner, repo.name));
    repo.name = body.name;
    forge.repos.set(forge.key(repo.owner, repo.name), repo);
  }
  return ok(repoJson(repo, req.origin));
}

// ---------------------------------------------------------------------------------------------
// branches, commits, git refs
// ---------------------------------------------------------------------------------------------

function handleBranches(forge: Forge, repo: Repo, req: RestRequest, rest: string[]): RestOutcome {
  if (req.method === 'GET' && rest.length === 0) {
    const branches = [...repo.refs.keys()]
      .filter((name) => name.startsWith('refs/heads/'))
      .map((name) => name.slice('refs/heads/'.length))
      .sort()
      .map((name) => ({ name, commit: { sha: repo.refs.get(`refs/heads/${name}`)! } }));
    return { result: ok(branches) };
  }
  if (req.method === 'GET' && rest.length === 1) {
    const tip = repo.refs.get(`refs/heads/${rest[0]}`);
    if (tip === undefined) return { result: err(404, 'Branch not found') };
    return { result: ok({ name: rest[0], commit: { sha: tip } }) };
  }
  return { result: err(404, 'Not Found') };
}

function handleCommits(forge: Forge, repo: Repo, req: RestRequest, rest: string[]): RestOutcome {
  if (req.method !== 'GET' || rest.length !== 0) return { result: err(404, 'Not Found') };
  const shaParam = req.query.get('sha');
  const tip = shaParam === null ? repo.refs.get(`refs/heads/${repo.defaultBranch}`) : forge.resolveRef(repo, shaParam);
  if (tip === undefined) return { result: ok([]) };
  const history = forge.commitHistory(repo, tip);
  const commits = history.map((oid) => {
    const object = repo.objects.get(oid)!;
    const view = parseCommit(object.data);
    return {
      sha: oid,
      commit: {
        // The object stores the message with a trailing newline, as git does;
        // the API surface presents it without that trailing newline.
        message: view.message.replace(/\n+$/, ''),
        author: { name: VIEWER_NAME, email: `${VIEWER_LOGIN}@example.invalid`, date: identityDate(view.author) },
        committer: { name: VIEWER_NAME, email: `${VIEWER_LOGIN}@example.invalid`, date: identityDate(view.committer) },
        tree: { sha: view.tree },
      },
      parents: view.parents.map((p) => ({ sha: p })),
    };
  });
  return { result: ok(commits) };
}

// ---------------------------------------------------------------------------------------------
// git refs
// ---------------------------------------------------------------------------------------------

function handleGitRefs(forge: Forge, repo: Repo, req: RestRequest, rest: string[]): RestOutcome {
  if (rest[0] !== 'refs') return { result: err(404, 'Not Found') };
  if (req.method === 'POST' && rest.length === 1) {
    const body = isRecord(req.body) ? req.body : {};
    const ref = asString(body.ref);
    const sha = asString(body.sha);
    if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha)) return err(422, 'Invalid ref or sha');
    if (repo.refs.has(ref)) return err(422, 'Reference already exists');
    if (!repo.objects.has(sha)) return err(422, 'Object does not exist');
    repo.refs.set(ref, sha);
    return { result: ok({ ref, object: { sha } }, 201) };
  }
  if (req.method === 'GET' && rest.length === 1) {
    const refs = [...repo.refs.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([name, oid]) => ({ ref: name, object: { sha: oid } }));
    return { result: ok(refs) };
  }
  if (req.method === 'GET' && rest.length === 3 && rest[1] === 'heads') {
    const tip = repo.refs.get(`refs/heads/${rest[2]}`);
    if (tip === undefined) return { result: err(404, 'Not Found') };
    return { result: ok({ ref: `refs/heads/${rest[2]}`, object: { sha: tip } }) };
  }
  return { result: err(404, 'Not Found') };
}

// ---------------------------------------------------------------------------------------------
// contents
// ---------------------------------------------------------------------------------------------

function handleContents(forge: Forge, repo: Repo, req: RestRequest, rest: string[]): RestOutcome {
  const path = rest.join('/');
  if (req.method === 'PUT') {
    const body = isRecord(req.body) ? req.body : {};
    const message = asString(body.message);
    const contentB64 = asString(body.content);
    const branch = asString(body.branch) || repo.defaultBranch;
    const sha = typeof body.sha === 'string' ? body.sha : undefined;
    if (message === '' || contentB64 === '') return { result: err(422, 'message and content are required') };
    let content: Buffer;
    try {
      content = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
    } catch {
      return { result: err(422, 'content is not valid base64') };
    }
    // Resolve (or create) the branch.
    let branchTip = repo.refs.get(`refs/heads/${branch}`);
    if (branchTip === undefined) {
      const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (defaultTip === undefined && branch !== repo.defaultBranch) return { result: err(404, 'Branch not found') };
      if (defaultTip !== undefined) repo.refs.set(`refs/heads/${branch}`, defaultTip);
      branchTip = repo.refs.get(`refs/heads/${branch}`);
    }
    const existing = branchTip === undefined ? null : forge.readPath(repo, branch, path);
    if (sha !== undefined) {
      if (existing === null || existing.kind !== 'file' || existing.oid !== sha) {
        return { result: err(409, 'sha does not match the current blob') };
      }
    }
    const isUpdate = existing !== null && existing.kind === 'file';
    const { commitOid, blobOid } = forge.commitFile(repo, branch, path, content, message);
    return {
      result: ok(
        {
          content: {
            name: path.split('/').pop() ?? path,
            path,
            sha: blobOid,
            size: content.length,
            encoding: 'base64',
            content: content.toString('base64'),
          },
          commit: { sha: commitOid, message },
        },
        isUpdate ? 200 : 201,
      ),
    };
  }
  if (req.method === 'GET') {
    const ref = req.query.get('ref') ?? undefined;
    const read = forge.readPath(repo, ref, path);
    if (read === null) return { result: err(404, 'Not Found') };
    if (read.kind === 'file') {
      return {
        result: ok({
          type: 'file',
          encoding: 'base64',
          size: read.data.length,
          name: path.split('/').pop() ?? path,
          path,
          content: read.data.toString('base64'),
          sha: read.oid,
        }),
      };
    }
    return {
      result: ok(
        read.entries.map((entry) => ({
          type: entry.type,
          name: entry.name,
          path: entry.path,
          sha: entry.oid,
        })),
      ),
    };
  }
  if (req.method === 'DELETE') {
    const body = isRecord(req.body) ? req.body : {};
    const message = asString(body.message) || 'delete file';
    const sha = typeof body.sha === 'string' ? body.sha : undefined;
    const branch = asString(body.branch) || repo.defaultBranch;
    const existing = forge.readPath(repo, branch, path);
    if (existing === null || existing.kind !== 'file') return { result: err(404, 'Not Found') };
    if (sha !== undefined && existing.oid !== sha) return { result: err(409, 'sha does not match the current blob') };
    const deleted = forge.deleteFile(repo, branch, path, message);
    if (deleted === null) return { result: err(404, 'Not Found') };
    return { result: ok({ commit: { sha: deleted.commitOid } }) };
  }
  return { result: err(404, 'Not Found') };
}

// ---------------------------------------------------------------------------------------------
// labels and issues
// ---------------------------------------------------------------------------------------------

function handleLabels(forge: Forge, repo: Repo, req: RestRequest, rest: string[]): RestOutcome {
  if (rest.length !== 0) return { result: err(404, 'Not Found') };
  if (req.method === 'GET') {
    return { result: ok([...repo.labels.values()].map((label) => ({ name: label.name, color: label.color }))) };
  }
  if (req.method === 'POST') {
    const body = isRecord(req.body) ? req.body : {};
    const name = asString(body.name);
    const color = asString(body.color) || 'ededed';
    if (name === '') return err(422, 'name is required');
    const existing = repo.labels.get(name);
    if (existing) return { result: ok({ name: existing.name, color: existing.color }, 201) };
    const label = { name, color };
    repo.labels.set(name, label);
    return { result: ok({ name, color }, 201) };
  }
  return { result: err(404, 'Not Found') };
}

function handleIssues(forge: Forge, repo: Repo, req: RestRequest, rest: string[]): RestOutcome {
  if (rest.length === 0) {
    if (req.method === 'POST') {
      const body = isRecord(req.body) ? req.body : {};
      const title = asString(body.title);
      const text = asString(body.body);
      if (title === '') return { result: err(422, 'title is required') };
      const labelNames = Array.isArray(body.labels) ? body.labels.filter((l): l is string => typeof l === 'string') : [];
      const labels: Array<{ name: string; color: string }> = [];
      for (const name of labelNames) {
        const label = repo.labels.get(name);
        if (!label) return { result: err(422, `Label does not exist: ${name}`) };
        labels.push(label);
      }
      const issue = forge.createIssue(repo, title, text, labels);
      return { result: ok(issueJson(issue, repo), 201) };
    }
    if (req.method === 'GET') {
      const params = pageParams(req.query);
      const state = req.query.get('state') ?? 'open';
      const sort = req.query.get('sort') ?? 'created';
      const direction = req.query.get('direction') ?? 'desc';
      let issues = repo.issues.filter((issue) => (state === 'all' ? true : issue.state === state));
      if (sort === 'created') {
        issues = [...issues].sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
      }
      const { page } = paginate(issues, params);
      return { result: ok(page.map((issue) => issueJson(issue, repo))) };
    }
    return { result: err(404, 'Not Found') };
  }

  const number = Number.parseInt(rest[0]!, 10);
  if (!Number.isInteger(number) || number < 1) return { result: err(404, 'Not Found') };
  const issue = repo.issues.find((entry) => entry.number === number);
  if (issue === undefined) return { result: err(404, 'Not Found') };

  if (rest.length === 1) {
    if (req.method === 'GET') return { result: ok(issueJson(issue, repo)) };
    if (req.method === 'PATCH') {
      const body = isRecord(req.body) ? req.body : {};
      if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      issue.updatedSeq = forge.advanceSeq();
      return { result: ok(issueJson(issue, repo)) };
    }
    return { result: err(404, 'Not Found') };
  }

  if (rest.length === 2 && rest[1] === 'comments') {
    if (req.method === 'GET') {
      return {
        result: ok(
          issue.comments.map((comment) => ({
            id: comment.id,
            body: comment.body,
            user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
            created_at: isoOf(comment.createdSeq),
          })),
        ),
      };
    }
    if (req.method === 'POST') {
      const body = isRecord(req.body) ? req.body : {};
      const text = asString(body.body);
      if (text === '') return { result: err(422, 'body is required') };
      const comment = { id: repo.nextCommentId++, body: text, createdSeq: forge.advanceSeq() };
      issue.comments.push(comment);
      return {
        result: ok(
          {
            id: comment.id,
            body: comment.body,
            user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
            created_at: isoOf(comment.createdSeq),
          },
          201,
        ),
      };
    }
    return { result: err(404, 'Not Found') };
  }
  return { result: err(404, 'Not Found') };
}

// ---------------------------------------------------------------------------------------------
// pull requests
// ---------------------------------------------------------------------------------------------

function handlePulls(forge: Forge, repo: Repo, req: RestRequest, rest: string[]): RestOutcome {
  if (rest.length === 0) {
    if (req.method === 'POST') {
      const body = isRecord(req.body) ? req.body : {};
      const title = asString(body.title);
      const text = asString(body.body);
      const head = asString(body.head);
      const base = asString(body.base) || repo.defaultBranch;
      if (title === '' || head === '') return { result: err(422, 'title and head are required') };
      if (repo.refs.get(`refs/heads/${head}`) === undefined) return { result: err(422, `head branch does not exist: ${head}`) };
      if (repo.refs.get(`refs/heads/${base}`) === undefined) return { result: err(422, `base branch does not exist: ${base}`) };
      const existing = repo.pulls.find((pull) => pull.head.ref === head && pull.base.ref === base && pull.state === 'open');
      if (existing) return { result: err(422, 'A pull request already exists for this head and base') };
      const pull = forge.createPull(repo, title, text, head, base);
      if (pull === null) return { result: err(422, 'could not create the pull request') };
      return { result: ok(pullJson(pull, repo), 201) };
    }
    if (req.method === 'GET') {
      const params = pageParams(req.query);
      const state = req.query.get('state') ?? 'open';
      const pulls = repo.pulls.filter((pull) => (state === 'all' ? true : pull.state === state));
      const { page } = paginate(pulls, params);
      return { result: ok(page.map((pull) => pullJson(pull, repo))) };
    }
    return { result: err(404, 'Not Found') };
  }

  const number = Number.parseInt(rest[0]!, 10);
  if (!Number.isInteger(number) || number < 1) return { result: err(404, 'Not Found') };
  const pull = repo.pulls.find((entry) => entry.number === number);
  if (pull === undefined) return { result: err(404, 'Not Found') };

  if (rest.length === 1) {
    if (req.method === 'GET') return { result: ok(pullJson(pull, repo)) };
    return { result: err(404, 'Not Found') };
  }

  if (rest.length === 2 && rest[1] === 'files' && req.method === 'GET') {
    const baseTip = forge.resolveRef(repo, pull.base.ref);
    const headTip = forge.resolveRef(repo, pull.head.ref);
    if (baseTip === undefined || headTip === undefined) return { result: ok([]) };
    const baseCommit = repo.objects.get(baseTip);
    const headCommit = repo.objects.get(headTip);
    if (!baseCommit || !headCommit) return { result: ok([]) };
    const mergeBaseOid = forge.mergeBase(repo, baseTip, headTip) ?? baseTip;
    const mergeBaseCommit = repo.objects.get(mergeBaseOid);
    if (!mergeBaseCommit) return { result: ok([]) };
    const files = forge.diffTrees(repo, parseCommit(mergeBaseCommit.data).tree, parseCommit(headCommit.data).tree);
    return {
      result: ok(
        files.map((file) => ({
          filename: file.path,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          changes: file.additions + file.deletions,
          sha: file.newOid ?? file.oldOid ?? '',
        })),
      ),
    };
  }

  if (rest.length === 2 && rest[1] === 'merge' && req.method === 'PUT') {
    if (pull.state !== 'open' || pull.merged) return { result: err(405, 'Pull request is already closed') };
    const mergeOid = forge.squashMerge(repo, pull);
    if (mergeOid === null) return { result: err(405, 'Merge conflict') };
    pull.merged = true;
    pull.state = 'closed';
    pull.merge_commit_sha = mergeOid;
    pull.merged_at = forge.timestamp().iso;
    pull.updatedSeq = forge.advanceSeq();
    return {
      result: ok({
        sha: mergeOid,
        merged: true,
        message: `${pull.title} (#${pull.number})`,
      }),
    };
  }
  return { result: err(404, 'Not Found') };
}
