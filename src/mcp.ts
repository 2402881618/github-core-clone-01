// mcp.ts — the Model Context Protocol endpoint (POST /mcp, Streamable HTTP).
//
// Modern era first: `server/discover` (2026-07-28) answers the server's
// identity, capabilities and supported revisions. The pre-discover handshake
// (`initialize` + `notifications/initialized`) is implemented as a fallback.
// Answers are plain JSON-RPC over HTTP (no SSE frames); notifications are
// answered 202 with an empty body.

import { VIEWER_LOGIN, type Forge, type Repo } from './store.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';

export const MCP_SERVER_NAME = 'github-core-clone-forge';
export const MCP_SERVER_VERSION = '1.0.0';
export const MCP_PREFERRED_REVISION = '2026-07-28';
export const MCP_SUPPORTED_REVISIONS = Object.freeze([
  '2026-07-28',
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
]);

const SERVER_INFO = Object.freeze({ name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION });

export interface McpOutcome {
  status: number;
  /** The JSON-RPC response object, or null for an empty (202/204) reply. */
  body: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------------------------
// the tool table: one constant, serialized the same way on every call
// ---------------------------------------------------------------------------------------------

interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: readonly McpTool[] = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all (default open).' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge an open pull request onto its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
]);

// ---------------------------------------------------------------------------------------------
// JSON-RPC helpers
// ---------------------------------------------------------------------------------------------

function result(id: unknown, value: unknown): McpOutcome {
  return { status: 200, body: { jsonrpc: '2.0', id, result: value } };
}

function rpcError(id: unknown, code: number, message: string, status = 200): McpOutcome {
  return { status, body: { jsonrpc: '2.0', id, error: { code, message } } };
}

function toolResult(data: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Read an argument by its canonical name, accepting a few common synonyms. */
function arg(args: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) if (args[name] !== undefined) return args[name];
  return undefined;
}

function argString(args: Record<string, unknown>, ...names: string[]): string {
  const value = arg(args, ...names);
  return typeof value === 'string' ? value : '';
}

function argInt(args: Record<string, unknown>, ...names: string[]): number | null {
  const value = arg(args, ...names);
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

function findRepo(forge: Forge, owner: string, repoName: string): Repo | null {
  if (owner !== VIEWER_LOGIN) return null;
  return forge.getRepo(owner, repoName) ?? null;
}

// ---------------------------------------------------------------------------------------------
// tool execution (all tools act on the same store as the REST surface)
// ---------------------------------------------------------------------------------------------

function callTool(forge: Forge, name: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case 'create_repo': {
      const repoName = argString(args, 'name', 'repo', 'repository');
      const description = argString(args, 'description', 'about', 'summary');
      const isPrivate = args.private === true || args.is_private === true;
      if (repoName === '') return toolError('create_repo requires a name.');
      if (forge.getRepo(VIEWER_LOGIN, repoName) !== undefined) return toolError(`Repository ${VIEWER_LOGIN}/${repoName} already exists.`);
      const repo = forge.createRepo(VIEWER_LOGIN, repoName, description, isPrivate);
      return toolResult(repoJson(repo, ''));
    }
    case 'get_repo': {
      const owner = argString(args, 'owner', 'owner_login', 'login');
      const repoName = argString(args, 'repo', 'repository', 'name');
      const repo = findRepo(forge, owner, repoName);
      if (repo === null) return toolError(`Repository ${owner}/${repoName} was not found.`);
      return toolResult(repoJson(repo, ''));
    }
    case 'create_issue': {
      const owner = argString(args, 'owner', 'owner_login', 'login');
      const repoName = argString(args, 'repo', 'repository', 'name');
      const title = argString(args, 'title', 'issue_title', 'subject');
      const body = argString(args, 'body', 'issue_body', 'description', 'content', 'text');
      if (owner === '' || repoName === '' || title === '') return toolError('create_issue requires owner, repo and title.');
      const repo = findRepo(forge, owner, repoName);
      if (repo === null) return toolError(`Repository ${owner}/${repoName} was not found.`);
      const issue = forge.createIssue(repo, title, body, []);
      return toolResult(issueJson(issue, repo));
    }
    case 'list_issues': {
      const owner = argString(args, 'owner', 'owner_login', 'login');
      const repoName = argString(args, 'repo', 'repository', 'name');
      const state = argString(args, 'state', 'status') || 'open';
      if (owner === '' || repoName === '') return toolError('list_issues requires owner and repo.');
      const repo = findRepo(forge, owner, repoName);
      if (repo === null) return toolError(`Repository ${owner}/${repoName} was not found.`);
      const issues = repo.issues
        .filter((issue) => (state === 'all' ? true : issue.state === state))
        .map((issue) => issueJson(issue, repo));
      return toolResult(issues);
    }
    case 'create_pull_request': {
      const owner = argString(args, 'owner', 'owner_login', 'login');
      const repoName = argString(args, 'repo', 'repository', 'name');
      const title = argString(args, 'title', 'pr_title', 'subject');
      const body = argString(args, 'body', 'description', 'content', 'text');
      const head = argString(args, 'head', 'head_ref', 'head_branch', 'source_branch');
      const base = argString(args, 'base', 'base_ref', 'base_branch', 'target_branch') || '';
      if (owner === '' || repoName === '' || title === '' || head === '' || base === '') {
        return toolError('create_pull_request requires owner, repo, title, head and base.');
      }
      const repo = findRepo(forge, owner, repoName);
      if (repo === null) return toolError(`Repository ${owner}/${repoName} was not found.`);
      if (repo.refs.get(`refs/heads/${head}`) === undefined) return toolError(`Head branch ${head} does not exist.`);
      if (repo.refs.get(`refs/heads/${base}`) === undefined) return toolError(`Base branch ${base} does not exist.`);
      if (repo.pulls.some((pull) => pull.head.ref === head && pull.base.ref === base && pull.state === 'open')) {
        return toolError('A pull request already exists for this head and base.');
      }
      const pull = forge.createPull(repo, title, body, head, base);
      if (pull === null) return toolError('Could not create the pull request.');
      return toolResult(pullJson(pull, repo));
    }
    case 'merge_pull_request': {
      const owner = argString(args, 'owner', 'owner_login', 'login');
      const repoName = argString(args, 'repo', 'repository', 'name');
      const number = argInt(args, 'pull_number', 'pull_request_number', 'pr_number', 'number');
      if (owner === '' || repoName === '' || number === null) {
        return toolError('merge_pull_request requires owner, repo and pull_number.');
      }
      const repo = findRepo(forge, owner, repoName);
      if (repo === null) return toolError(`Repository ${owner}/${repoName} was not found.`);
      const pull = repo.pulls.find((entry) => entry.number === number);
      if (pull === undefined) return toolError(`Pull request #${number} was not found.`);
      if (pull.state !== 'open' || pull.merged) return toolError(`Pull request #${number} is already closed.`);
      const mergeOid = forge.squashMerge(repo, pull);
      if (mergeOid === null) return toolError(`Pull request #${number} has a merge conflict.`);
      pull.merged = true;
      pull.state = 'closed';
      pull.merge_commit_sha = mergeOid;
      pull.merged_at = forge.timestamp().iso;
      pull.updatedSeq = forge.advanceSeq();
      return toolResult(pullJson(pull, repo));
    }
    default:
      // Unknown tool names are a JSON-RPC error, never an HTTP 500; the dispatcher
      // turns this into -32602, so this branch is unreachable through it.
      return toolError(`Unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------------------------------------
// dispatcher
// ---------------------------------------------------------------------------------------------

/**
 * Handle one parsed JSON-RPC request body. `parsed` is the JSON value of the
 * request body (the caller handles non-JSON bodies with a -32700 answer).
 */
export function handleMcp(forge: Forge, parsed: unknown): McpOutcome {
  if (!isRecord(parsed)) {
    return rpcError(null, -32600, 'Invalid Request: the body must be a JSON-RPC object.');
  }
  const id = 'id' in parsed ? parsed.id : undefined;
  const method = typeof parsed.method === 'string' ? parsed.method : '';
  const params = isRecord(parsed.params) ? parsed.params : {};

  // A request without an id is a notification: answer 202 with no body.
  if (id === undefined) return { status: 202, body: null };

  switch (method) {
    case 'server/discover':
      return result(id, {
        supportedVersions: [...MCP_SUPPORTED_REVISIONS],
        capabilities: { tools: {} },
        serverInfo: { ...SERVER_INFO },
        _meta: { 'io.modelcontextprotocol/serverInfo': { ...SERVER_INFO } },
      });
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const negotiated = (MCP_SUPPORTED_REVISIONS as readonly string[]).includes(offered) ? offered : '2025-11-25';
      return result(id, {
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: { ...SERVER_INFO },
      });
    }
    case 'ping':
      return result(id, {});
    case 'tools/list':
      return result(id, { tools: TOOLS });
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = isRecord(params.arguments) ? params.arguments : {};
      if (name === '') return rpcError(id, -32602, 'Invalid params: tools/call requires a tool name.');
      if (!TOOLS.some((tool) => tool.name === name)) {
        return rpcError(id, -32602, `Unknown tool: ${name}`);
      }
      return result(id, callTool(forge, name, args));
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}
