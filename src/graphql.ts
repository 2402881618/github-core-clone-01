// graphql.ts — a small, strict-enough GraphQL executor for the forge's surface.
//
// It parses the documents the suite sends (operations, variables, aliases,
// inline fragments, input objects, lists, enums, __type introspection), executes
// them against the shared in-memory store, and answers with {data} — or HTTP
// 200 with an `errors` array when a document names a field the schema does
// not hold. Batching (a JSON array body) answers in order.

import { Buffer } from 'node:buffer';
import { parseCommit } from './git-core.ts';
import {
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  type Forge,
  type Issue,
  type IssueComment,
  type PullRequest,
  type Repo,
} from './store.ts';

// ---------------------------------------------------------------------------------------------
// global ids: base64 of a typed string, so they are opaque and stable
// ---------------------------------------------------------------------------------------------

export function encodeGlobalId(kind: string, numericId: number): string {
  return Buffer.from(`${kind}:${numericId}`, 'utf8').toString('base64');
}

export function decodeGlobalId(id: string): { kind: string; numericId: number } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const match = /^([A-Za-z]+):(\d+)$/.exec(text);
    if (!match) return null;
    return { kind: match[1]!, numericId: Number(match[2]) };
  } catch {
    return null;
  }
}

function repoGlobalId(repo: Repo): string {
  return encodeGlobalId('R', repo.id);
}

function issueGlobalId(issue: Issue): string {
  return encodeGlobalId('I', issue.id);
}

function pullGlobalId(pull: PullRequest): string {
  return encodeGlobalId('PR', pull.id);
}

function commentGlobalId(comment: IssueComment): string {
  return encodeGlobalId('C', comment.id);
}

// ---------------------------------------------------------------------------------------------
// cursors: base64 of the absolute index in the filtered list
// ---------------------------------------------------------------------------------------------

function encodeCursor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: string | null | undefined): number {
  if (typeof cursor !== 'string' || cursor === '') return -1;
  try {
    const match = /^cursor:(\d+)$/.exec(Buffer.from(cursor, 'base64').toString('utf8'));
    if (!match) return -1;
    return Number(match[1]);
  } catch {
    return -1;
  }
}

// ---------------------------------------------------------------------------------------------
// tokenizer
// ---------------------------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'variable'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'spread' };

const PUNCT = new Set(['{', '}', '(', ')', ':', ',', '!', '=', '[', ']', '@', '|', '&']);

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread' });
      i += 3;
      continue;
    }
    if (PUNCT.has(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '$') {
      let j = i + 1;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j]!)) j += 1;
      tokens.push({ kind: 'variable', value: source.slice(i + 1, j) });
      i = j;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1]!;
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === 'u' && j + 5 < source.length) {
            out += String.fromCharCode(Number.parseInt(source.slice(j + 2, j + 6), 16));
            j += 4;
          } else out += esc;
          j += 2;
        } else {
          out += source[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (source[j] === '-') j += 1;
      let isFloat = false;
      while (j < source.length && /[0-9]/.test(source[j]!)) j += 1;
      if (source[j] === '.' && /[0-9]/.test(source[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j]!)) j += 1;
      }
      const text = source.slice(i, j);
      tokens.push(isFloat ? { kind: 'float', value: Number(text) } : { kind: 'int', value: Number(text) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j]!)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new GraphQLError(`Unexpected character ${JSON.stringify(ch)} in the GraphQL document.`);
  }
  return tokens;
}

// ---------------------------------------------------------------------------------------------
// parser
// ---------------------------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Record<string, ValueNode> };

type Selection =
  | { kind: 'field'; name: string; alias: string | null; args: Record<string, ValueNode>; selections: Selection[] }
  | { kind: 'fragmentSpread'; name: string }
  | { kind: 'inlineFragment'; typeCondition: string | null; selections: Selection[] };

interface Operation {
  kind: 'operation';
  operation: 'query' | 'mutation';
  name: string | null;
  selections: Selection[];
}

interface Fragment {
  kind: 'fragment';
  name: string;
  typeCondition: string;
  selections: Selection[];
}

export class GraphQLError extends Error {}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new GraphQLError('Unexpected end of the GraphQL document.');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new GraphQLError(`Expected "${value}" in the GraphQL document.`);
    }
  }

  private expectName(what = 'a name'): string {
    const token = this.next();
    if (token.kind !== 'name') throw new GraphQLError(`Expected ${what} in the GraphQL document.`);
    return token.value;
  }

  parseDocument(): { operations: Operation[]; fragments: Map<string, Fragment> } {
    const operations: Operation[] = [];
    const fragments = new Map<string, Fragment>();
    while (this.pos < this.tokens.length) {
      const token = this.peek()!;
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ kind: 'operation', operation: 'query', name: null, selections: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName('a fragment name');
        const on = this.expectName('the "on" keyword');
        if (on !== 'on') throw new GraphQLError('Expected "on" after a fragment name.');
        const typeCondition = this.expectName('a type name');
        this.skipDirectives();
        fragments.set(name, { kind: 'fragment', name, typeCondition, selections: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
        this.next();
        let name: string | null = null;
        if (this.peek()?.kind === 'name') name = this.next().value as string;
        this.skipVariableDefinitions();
        this.skipDirectives();
        operations.push({
          kind: 'operation',
          operation: token.value === 'subscription' ? 'query' : (token.value as 'query' | 'mutation'),
          name,
          selections: this.parseSelectionSet(),
        });
        continue;
      }
      throw new GraphQLError(`Unexpected token ${JSON.stringify(token)} in the GraphQL document.`);
    }
    if (operations.length === 0) throw new GraphQLError('The GraphQL document holds no operation.');
    return { operations, fragments };
  }

  /** Skip `( $var: Type = default, ... )` after an operation name. */
  private skipVariableDefinitions(): void {
    if (this.peek()?.kind === 'punct' && this.peek()!.value === '(') {
      let depth = 0;
      do {
        const token = this.next();
        if (token.kind === 'punct' && token.value === '(') depth += 1;
        if (token.kind === 'punct' && token.value === ')') depth -= 1;
      } while (depth > 0 && this.pos < this.tokens.length);
    }
  }

  /** Skip `@directive(args)` occurrences. */
  private skipDirectives(): void {
    while (this.peek()?.kind === 'punct' && this.peek()!.value === '@') {
      this.next();
      this.expectName('a directive name');
      if (this.peek()?.kind === 'punct' && this.peek()!.value === '(') this.parseArguments();
    }
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (true) {
      const token = this.peek();
      if (token === undefined) throw new GraphQLError('Unterminated selection set.');
      if (token.kind === 'punct' && token.value === '}') {
        this.next();
        return selections;
      }
      selections.push(this.parseSelection());
    }
  }

  private parseSelection(): Selection {
    const token = this.peek()!;
    if (token.kind === 'spread') {
      this.next();
      const next = this.peek();
      if (next?.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName('a type name');
        this.skipDirectives();
        return { kind: 'inlineFragment', typeCondition, selections: this.parseSelectionSet() };
      }
      if (next?.kind === 'name') {
        const name = this.next().value as string;
        this.skipDirectives();
        return { kind: 'fragmentSpread', name };
      }
      this.skipDirectives();
      return { kind: 'inlineFragment', typeCondition: null, selections: this.parseSelectionSet() };
    }
    const name = this.expectName('a field name');
    let alias: string | null = null;
    let fieldName = name;
    if (this.peek()?.kind === 'punct' && this.peek()!.value === ':') {
      this.next();
      alias = name;
      fieldName = this.expectName('a field name');
    }
    const args = this.peek()?.kind === 'punct' && this.peek()!.value === '(' ? this.parseArguments() : {};
    this.skipDirectives();
    const selections = this.peek()?.kind === 'punct' && this.peek()!.value === '{' ? this.parseSelectionSet() : [];
    return { kind: 'field', name: fieldName, alias, args, selections };
  }

  private parseArguments(): Record<string, ValueNode> {
    this.expectPunct('(');
    const args: Record<string, ValueNode> = {};
    while (true) {
      const token = this.peek();
      if (token === undefined) throw new GraphQLError('Unterminated argument list.');
      if (token.kind === 'punct' && token.value === ')') {
        this.next();
        return args;
      }
      const name = this.expectName('an argument name');
      this.expectPunct(':');
      args[name] = this.parseValue();
    }
  }

  private parseValue(): ValueNode {
    const token = this.next();
    switch (token.kind) {
      case 'variable':
        return { kind: 'variable', name: token.value };
      case 'string':
        return { kind: 'string', value: token.value };
      case 'int':
        return { kind: 'int', value: token.value };
      case 'float':
        return { kind: 'float', value: token.value };
      case 'name':
        if (token.value === 'true') return { kind: 'boolean', value: true };
        if (token.value === 'false') return { kind: 'boolean', value: false };
        if (token.value === 'null') return { kind: 'null' };
        return { kind: 'enum', value: token.value };
      case 'punct':
        if (token.value === '[') {
          const items: ValueNode[] = [];
          while (true) {
            const next = this.peek();
            if (next === undefined) throw new GraphQLError('Unterminated list value.');
            if (next.kind === 'punct' && next.value === ']') {
              this.next();
              return { kind: 'list', items };
            }
            items.push(this.parseValue());
          }
        }
        if (token.value === '{') {
          const fields: Record<string, ValueNode> = {};
          while (true) {
            const next = this.peek();
            if (next === undefined) throw new GraphQLError('Unterminated input object.');
            if (next.kind === 'punct' && next.value === '}') {
              this.next();
              return { kind: 'object', fields };
            }
            const name = this.expectName('an input field name');
            this.expectPunct(':');
            fields[name] = this.parseValue();
          }
        }
        throw new GraphQLError(`Unexpected token ${JSON.stringify(token.value)} in a value.`);
      default:
        throw new GraphQLError('Unexpected token in a value.');
    }
  }
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name] ?? null;
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node.fields)) out[key] = resolveValue(value, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// the static schema table, for __type introspection
// ---------------------------------------------------------------------------------------------

interface SchemaField {
  name: string;
  typeName: string;
  kind: 'SCALAR' | 'OBJECT' | 'ENUM' | 'LIST' | 'NON_NULL';
}

interface SchemaType {
  kind: 'OBJECT' | 'ENUM';
  fields: SchemaField[];
  enumValues: string[];
}

const SCALAR = (name: string, typeName: string): SchemaField => ({ name, typeName, kind: 'SCALAR' });

const SCHEMA: Record<string, SchemaType> = {
  Issue: {
    kind: 'OBJECT',
    fields: [
      SCALAR('id', 'ID'),
      SCALAR('databaseId', 'Int'),
      SCALAR('number', 'Int'),
      SCALAR('title', 'String'),
      SCALAR('state', 'IssueState'),
      SCALAR('body', 'String'),
      SCALAR('url', 'URI'),
      { name: 'author', typeName: 'Actor', kind: 'OBJECT' },
      SCALAR('createdAt', 'DateTime'),
      SCALAR('updatedAt', 'DateTime'),
      { name: 'labels', typeName: 'LabelConnection', kind: 'OBJECT' },
      { name: 'comments', typeName: 'IssueCommentConnection', kind: 'OBJECT' },
    ],
    enumValues: [],
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: [
      SCALAR('id', 'ID'),
      SCALAR('databaseId', 'Int'),
      SCALAR('number', 'Int'),
      SCALAR('title', 'String'),
      SCALAR('body', 'String'),
      SCALAR('state', 'PullRequestState'),
      SCALAR('headRefName', 'String'),
      SCALAR('baseRefName', 'String'),
      { name: 'headRef', typeName: 'Ref', kind: 'OBJECT' },
      { name: 'baseRef', typeName: 'Ref', kind: 'OBJECT' },
      SCALAR('mergeable', 'MergeableState'),
      SCALAR('merged', 'Boolean'),
      SCALAR('mergedAt', 'DateTime'),
      { name: 'mergeCommit', typeName: 'Commit', kind: 'OBJECT' },
      { name: 'files', typeName: 'PullRequestChangedFileConnection', kind: 'OBJECT' },
      { name: 'author', typeName: 'Actor', kind: 'OBJECT' },
    ],
    enumValues: [],
  },
  Repository: {
    kind: 'OBJECT',
    fields: [
      SCALAR('id', 'ID'),
      SCALAR('databaseId', 'Int'),
      SCALAR('name', 'String'),
      SCALAR('nameWithOwner', 'String'),
      { name: 'owner', typeName: 'User', kind: 'OBJECT' },
      { name: 'defaultBranchRef', typeName: 'Ref', kind: 'OBJECT' },
      SCALAR('viewerPermission', 'RepositoryPermission'),
      SCALAR('hasIssuesEnabled', 'Boolean'),
      { name: 'issue', typeName: 'Issue', kind: 'OBJECT' },
      { name: 'issues', typeName: 'IssueConnection', kind: 'OBJECT' },
      { name: 'pullRequest', typeName: 'PullRequest', kind: 'OBJECT' },
      { name: 'pullRequests', typeName: 'PullRequestConnection', kind: 'OBJECT' },
      SCALAR('url', 'URI'),
      SCALAR('description', 'String'),
      SCALAR('isPrivate', 'Boolean'),
    ],
    enumValues: [],
  },
  SearchType: {
    kind: 'ENUM',
    fields: [],
    enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'],
  },
  Viewer: {
    kind: 'OBJECT',
    fields: [SCALAR('login', 'String'), SCALAR('id', 'ID'), SCALAR('name', 'String')],
    enumValues: [],
  },
  User: {
    kind: 'OBJECT',
    fields: [SCALAR('login', 'String'), SCALAR('id', 'ID'), SCALAR('name', 'String')],
    enumValues: [],
  },
};

// ---------------------------------------------------------------------------------------------
// resolved values
// ---------------------------------------------------------------------------------------------

type GqlObject =
  | { __typename: 'Query' }
  | { __typename: 'Mutation' }
  | { __typename: 'Viewer' }
  | { __typename: 'User'; login: string }
  | { __typename: 'Repository'; repo: Repo }
  | { __typename: 'Ref'; name: string }
  | { __typename: 'Issue'; repo: Repo; issue: Issue }
  | { __typename: 'PullRequest'; repo: Repo; pull: PullRequest }
  | { __typename: 'IssueComment'; repo: Repo; issue: Issue; comment: IssueComment }
  | { __typename: 'IssueEdge'; node: GqlObject; cursor: string }
  | { __typename: 'PullRequestEdge'; node: GqlObject; cursor: string }
  | { __typename: 'PullRequestChangedFileEdge'; node: GqlObject; cursor: string }
  | { __typename: 'PullRequestChangedFile'; path: string; additions: number; deletions: number; changeType: string }
  | { __typename: 'IssueConnection'; nodes: GqlObject[]; pageInfo: PageInfoValue; totalCount: number }
  | { __typename: 'PullRequestConnection'; nodes: GqlObject[]; pageInfo: PageInfoValue; totalCount: number }
  | { __typename: 'PullRequestChangedFileConnection'; nodes: GqlObject[]; pageInfo: PageInfoValue; totalCount: number }
  | { __typename: 'PageInfo'; hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null }
  | { __typename: '__Type'; name: string }
  | { __typename: '__Field'; name: string; typeName: string; kind: string }
  | { __typename: '__EnumValue'; name: string }
  | { __typename: '__TypeRef'; name: string | null; kind: string; ofType: GqlObject | null }
  | { __typename: 'CreateIssuePayload'; issue: GqlObject | null }
  | { __typename: 'CloseIssuePayload'; issue: GqlObject | null }
  | { __typename: 'CreatePullRequestPayload'; pullRequest: GqlObject | null }
  | { __typename: 'MergePullRequestPayload'; pullRequest: GqlObject | null }
  | { __typename: 'AddCommentPayload'; commentEdge: GqlObject | null };

interface PageInfoValue {
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startCursor: string | null;
  endCursor: string | null;
}

function issueObject(repo: Repo, issue: Issue): GqlObject {
  return { __typename: 'Issue', repo, issue };
}

function pullObject(repo: Repo, pull: PullRequest): GqlObject {
  return { __typename: 'PullRequest', repo, pull };
}

function commentObject(repo: Repo, issue: Issue, comment: IssueComment): GqlObject {
  return { __typename: 'IssueComment', repo, issue, comment };
}

/** Paginate an already filtered+sorted list of objects by first/after. */
function paginateNodes<T>(items: readonly T[], args: Record<string, unknown>): { page: T[]; pageInfo: PageInfoValue } {
  const afterIndex = decodeCursor(typeof args.after === 'string' ? args.after : null);
  const first = typeof args.first === 'number' && args.first >= 0 ? args.first : items.length;
  const start = afterIndex + 1;
  const page = items.slice(start, start + first);
  const lastIndex = start + page.length - 1;
  return {
    page,
    pageInfo: {
      hasNextPage: lastIndex + 1 < items.length,
      hasPreviousPage: start > 0,
      startCursor: page.length === 0 ? null : encodeCursor(start),
      endCursor: page.length === 0 ? null : encodeCursor(lastIndex),
    },
  };
}

function issueState(issue: Issue): 'OPEN' | 'CLOSED' {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: PullRequest): 'OPEN' | 'CLOSED' | 'MERGED' {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function findRepoById(forge: Forge, numericId: number): Repo | null {
  for (const repo of forge.repos.values()) if (repo.id === numericId) return repo;
  return null;
}

function findIssueById(forge: Forge, numericId: number): { repo: Repo; issue: Issue } | null {
  for (const repo of forge.repos.values()) {
    const issue = repo.issues.find((entry) => entry.id === numericId);
    if (issue) return { repo, issue };
  }
  return null;
}

function findPullById(forge: Forge, numericId: number): { repo: Repo; pull: PullRequest } | null {
  for (const repo of forge.repos.values()) {
    const pull = repo.pulls.find((entry) => entry.id === numericId);
    if (pull) return { repo, pull };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// field resolution
// ---------------------------------------------------------------------------------------------

function fieldError(parentType: string, field: string): GraphQLError {
  return new GraphQLError(`Cannot query field "${field}" on type "${parentType}".`);
}

function resolveField(forge: Forge, parent: GqlObject, field: string, args: Record<string, unknown>): unknown {
  if (field === '__typename') return parent.__typename;

  switch (parent.__typename) {
    case 'Query': {
      if (field === 'viewer') return { __typename: 'Viewer' } as GqlObject;
      if (field === 'repository') {
        const repo = forge.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
        if (repo === undefined || String(args.owner ?? '') !== VIEWER_LOGIN) return null;
        return { __typename: 'Repository', repo } as GqlObject;
      }
      if (field === 'node') {
        const decoded = decodeGlobalId(String(args.id ?? ''));
        if (!decoded) return null;
        if (decoded.kind === 'R') {
          const repo = findRepoById(forge, decoded.numericId);
          return repo === null ? null : ({ __typename: 'Repository', repo } as GqlObject);
        }
        if (decoded.kind === 'I') {
          const found = findIssueById(forge, decoded.numericId);
          return found === null ? null : issueObject(found.repo, found.issue);
        }
        if (decoded.kind === 'PR') {
          const found = findPullById(forge, decoded.numericId);
          return found === null ? null : pullObject(found.repo, found.pull);
        }
        return null;
      }
      if (field === '__type') {
        const name = String(args.name ?? '');
        if (!(name in SCHEMA)) return null;
        return { __typename: '__Type', name } as GqlObject;
      }
      throw fieldError('Query', field);
    }
    case 'Mutation': {
      if (field === 'createIssue') return createIssueMutation(forge, args);
      if (field === 'closeIssue') return closeIssueMutation(forge, args);
      if (field === 'createPullRequest') return createPullRequestMutation(forge, args);
      if (field === 'mergePullRequest') return mergePullRequestMutation(forge, args);
      if (field === 'addComment') return addCommentMutation(forge, args);
      throw fieldError('Mutation', field);
    }
    case 'Viewer': {
      if (field === 'login') return VIEWER_LOGIN;
      if (field === 'id') return encodeGlobalId('U', VIEWER_ID);
      if (field === 'name') return VIEWER_NAME;
      throw fieldError('Viewer', field);
    }
    case 'User': {
      if (field === 'login') return parent.login;
      if (field === 'id') return encodeGlobalId('U', parent.login === VIEWER_LOGIN ? VIEWER_ID : 0);
      if (field === 'name') return parent.login === VIEWER_LOGIN ? VIEWER_NAME : parent.login;
      throw fieldError('User', field);
    }
    case 'Repository': {
      const repo = parent.repo;
      switch (field) {
        case 'id':
          return repoGlobalId(repo);
        case 'databaseId':
          return repo.id;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return `${repo.owner}/${repo.name}`;
        case 'owner':
          return { __typename: 'User', login: repo.owner } as GqlObject;
        case 'defaultBranchRef': {
          const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          return tip === undefined ? null : ({ __typename: 'Ref', name: repo.defaultBranch } as GqlObject);
        }
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'url':
          return `https://github.com/${repo.owner}/${repo.name}`;
        case 'description':
          return repo.description;
        case 'isPrivate':
          return repo.private;
        case 'issue': {
          const number = Number(args.number);
          const issue = repo.issues.find((entry) => entry.number === number);
          return issue === undefined ? null : issueObject(repo, issue);
        }
        case 'issues': {
          let issues = [...repo.issues];
          const states = Array.isArray(args.states) ? (args.states as string[]) : null;
          if (states !== null) {
            const wanted = new Set(states.map((s) => String(s).toUpperCase()));
            issues = issues.filter((issue) => wanted.has(issueState(issue)));
          }
          const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
          const orderField = String(orderBy.field ?? 'CREATED_AT');
          const direction = String(orderBy.direction ?? 'DESC');
          const byCreated = (a: Issue, b: Issue): number => a.createdSeq - b.createdSeq;
          const byUpdated = (a: Issue, b: Issue): number => a.updatedSeq - b.updatedSeq;
          const cmp = orderField === 'UPDATED_AT' ? byUpdated : byCreated;
          issues.sort((a, b) => (direction === 'ASC' ? cmp(a, b) : -cmp(a, b)));
          const objects = issues.map((issue) => issueObject(repo, issue));
          const { page, pageInfo } = paginateNodes(objects, args);
          return { __typename: 'IssueConnection', nodes: page, pageInfo, totalCount: objects.length } as GqlObject;
        }
        case 'pullRequest': {
          const number = Number(args.number);
          const pull = repo.pulls.find((entry) => entry.number === number);
          return pull === undefined ? null : pullObject(repo, pull);
        }
        case 'pullRequests': {
          let pulls = [...repo.pulls];
          const states = Array.isArray(args.states) ? (args.states as string[]) : null;
          if (states !== null) {
            const wanted = new Set(states.map((s) => String(s).toUpperCase()));
            pulls = pulls.filter((pull) => wanted.has(pullState(pull)));
          }
          // GitHub's default pull request list is newest first.
          pulls.sort((a, b) => b.createdSeq - a.createdSeq);
          const objects = pulls.map((pull) => pullObject(repo, pull));
          const { page, pageInfo } = paginateNodes(objects, args);
          return { __typename: 'PullRequestConnection', nodes: page, pageInfo, totalCount: objects.length } as GqlObject;
        }
        default:
          throw fieldError('Repository', field);
      }
    }
    case 'Ref': {
      if (field === 'name') return parent.name;
      throw fieldError('Ref', field);
    }
    case 'Issue': {
      const issue = parent.issue;
      switch (field) {
        case 'id':
          return issueGlobalId(issue);
        case 'databaseId':
          return issue.id;
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'body':
          return issue.body;
        case 'state':
          return issueState(issue);
        case 'url':
          return `https://github.com/${parent.repo.owner}/${parent.repo.name}/issues/${issue.number}`;
        case 'author':
          return { __typename: 'User', login: VIEWER_LOGIN } as GqlObject;
        default:
          throw fieldError('Issue', field);
      }
    }
    case 'PullRequest': {
      const pull = parent.pull;
      const repo = parent.repo;
      switch (field) {
        case 'id':
          return pullGlobalId(pull);
        case 'databaseId':
          return pull.id;
        case 'number':
          return pull.number;
        case 'title':
          return pull.title;
        case 'body':
          return pull.body;
        case 'state':
          return pullState(pull);
        case 'headRefName':
          return pull.head.ref;
        case 'baseRefName':
          return pull.base.ref;
        case 'headRef':
          return { __typename: 'Ref', name: pull.head.ref } as GqlObject;
        case 'baseRef':
          return { __typename: 'Ref', name: pull.base.ref } as GqlObject;
        case 'merged':
          return pull.merged;
        case 'mergedAt':
          return pull.merged_at;
        case 'mergeable': {
          const baseTip = forge.resolveRef(repo, pull.base.ref);
          const headTip = forge.resolveRef(repo, pull.head.ref);
          if (baseTip === undefined || headTip === undefined) return 'UNKNOWN';
          return forge.mergeable(repo, baseTip, headTip);
        }
        case 'author':
          return { __typename: 'User', login: VIEWER_LOGIN } as GqlObject;
        case 'files': {
          const baseTip = forge.resolveRef(repo, pull.base.ref);
          const headTip = forge.resolveRef(repo, pull.head.ref);
          if (baseTip === undefined || headTip === undefined) {
            return {
              __typename: 'PullRequestChangedFileConnection',
              nodes: [],
              pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
              totalCount: 0,
            } as GqlObject;
          }
          const mergeBaseOid = forge.mergeBase(repo, baseTip, headTip) ?? baseTip;
          const mergeBaseCommit = repo.objects.get(mergeBaseOid);
          const headCommit = repo.objects.get(headTip);
          if (!mergeBaseCommit || !headCommit) {
            return {
              __typename: 'PullRequestChangedFileConnection',
              nodes: [],
              pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
              totalCount: 0,
            } as GqlObject;
          }
          const files = forge.diffTrees(repo, parseCommit(mergeBaseCommit.data).tree, parseCommit(headCommit.data).tree);
          const objects: GqlObject[] = files.map((file) => ({
            __typename: 'PullRequestChangedFile',
            path: file.path,
            additions: file.additions,
            deletions: file.deletions,
            changeType: file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'REMOVED' : 'MODIFIED',
          }));
          const { page, pageInfo } = paginateNodes(objects, args);
          return {
            __typename: 'PullRequestChangedFileConnection',
            nodes: page,
            pageInfo,
            totalCount: objects.length,
          } as GqlObject;
        }
        default:
          throw fieldError('PullRequest', field);
      }
    }
    case 'IssueComment': {
      if (field === 'id') return commentGlobalId(parent.comment);
      if (field === 'databaseId') return parent.comment.id;
      if (field === 'body') return parent.comment.body;
      if (field === 'author') return { __typename: 'User', login: VIEWER_LOGIN } as GqlObject;
      throw fieldError('IssueComment', field);
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestChangedFileConnection': {
      if (field === 'nodes') return parent.nodes;
      if (field === 'edges') {
        return parent.nodes.map((node, index) => {
          const edgeType =
            parent.__typename === 'IssueConnection'
              ? 'IssueEdge'
              : parent.__typename === 'PullRequestConnection'
                ? 'PullRequestEdge'
                : 'PullRequestChangedFileEdge';
          const cursor = parent.pageInfo.startCursor === null ? encodeCursor(index) : encodeCursor(decodeCursor(parent.pageInfo.startCursor) + index);
          return { __typename: edgeType, node, cursor } as GqlObject;
        });
      }
      if (field === 'pageInfo') return { __typename: 'PageInfo', ...parent.pageInfo } as GqlObject;
      if (field === 'totalCount') return parent.totalCount;
      throw fieldError(parent.__typename, field);
    }
    case 'IssueEdge':
    case 'PullRequestEdge':
    case 'PullRequestChangedFileEdge': {
      if (field === 'node') return parent.node;
      if (field === 'cursor') return parent.cursor;
      throw fieldError(parent.__typename, field);
    }
    case 'PullRequestChangedFile': {
      if (field === 'path') return parent.path;
      if (field === 'additions') return parent.additions;
      if (field === 'deletions') return parent.deletions;
      if (field === 'changeType') return parent.changeType;
      throw fieldError('PullRequestChangedFile', field);
    }
    case 'PageInfo': {
      if (field === 'hasNextPage') return parent.hasNextPage;
      if (field === 'hasPreviousPage') return parent.hasPreviousPage;
      if (field === 'startCursor') return parent.startCursor;
      if (field === 'endCursor') return parent.endCursor;
      throw fieldError('PageInfo', field);
    }
    case '__Type': {
      const schema = SCHEMA[parent.name]!;
      if (field === 'name') return parent.name;
      if (field === 'kind') return schema.kind;
      if (field === 'fields') {
        return schema.fields.map((entry) => ({ __typename: '__Field', name: entry.name, typeName: entry.typeName, kind: entry.kind }) as GqlObject);
      }
      if (field === 'enumValues') {
        return schema.enumValues.length === 0 ? null : schema.enumValues.map((name) => ({ __typename: '__EnumValue', name }) as GqlObject);
      }
      throw fieldError('__Type', field);
    }
    case '__Field': {
      if (field === 'name') return parent.name;
      if (field === 'description') return null;
      if (field === 'type') {
        return { __typename: '__TypeRef', name: parent.typeName, kind: parent.kind, ofType: null } as GqlObject;
      }
      throw fieldError('__Field', field);
    }
    case '__EnumValue': {
      if (field === 'name') return parent.name;
      if (field === 'description') return null;
      throw fieldError('__EnumValue', field);
    }
    case '__TypeRef': {
      if (field === 'name') return parent.name;
      if (field === 'kind') return parent.kind;
      if (field === 'ofType') return parent.ofType;
      throw fieldError('__TypeRef', field);
    }
    case 'CreateIssuePayload': {
      if (field === 'issue') return parent.issue;
      if (field === 'clientMutationId') return null;
      throw fieldError('CreateIssuePayload', field);
    }
    case 'CloseIssuePayload': {
      if (field === 'issue') return parent.issue;
      if (field === 'clientMutationId') return null;
      throw fieldError('CloseIssuePayload', field);
    }
    case 'CreatePullRequestPayload': {
      if (field === 'pullRequest') return parent.pullRequest;
      if (field === 'clientMutationId') return null;
      throw fieldError('CreatePullRequestPayload', field);
    }
    case 'MergePullRequestPayload': {
      if (field === 'pullRequest') return parent.pullRequest;
      if (field === 'clientMutationId') return null;
      throw fieldError('MergePullRequestPayload', field);
    }
    case 'AddCommentPayload': {
      if (field === 'commentEdge') return parent.commentEdge;
      if (field === 'clientMutationId') return null;
      throw fieldError('AddCommentPayload', field);
    }
    default:
      throw fieldError(parent.__typename, field);
  }
}

// ---------------------------------------------------------------------------------------------
// mutations
// ---------------------------------------------------------------------------------------------

function inputObject(args: Record<string, unknown>): Record<string, unknown> {
  const input = args.input;
  return input !== null && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
}

function createIssueMutation(forge: Forge, args: Record<string, unknown>): GqlObject {
  const input = inputObject(args);
  const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
  const repo = decoded?.kind === 'R' ? findRepoById(forge, decoded.numericId) : null;
  if (repo === null) throw new GraphQLError('Could not resolve to a Repository with the global id.');
  const title = String(input.title ?? '');
  const body = typeof input.body === 'string' ? input.body : '';
  const issue = forge.createIssue(repo, title, body, []);
  return { __typename: 'CreateIssuePayload', issue: issueObject(repo, issue) };
}

function closeIssueMutation(forge: Forge, args: Record<string, unknown>): GqlObject {
  const input = inputObject(args);
  const decoded = decodeGlobalId(String(input.issueId ?? ''));
  const found = decoded?.kind === 'I' ? findIssueById(forge, decoded.numericId) : null;
  if (found === null) throw new GraphQLError('Could not resolve to an Issue with the global id.');
  found.issue.state = 'closed';
  found.issue.updatedSeq = forge.advanceSeq();
  return { __typename: 'CloseIssuePayload', issue: issueObject(found.repo, found.issue) };
}

function createPullRequestMutation(forge: Forge, args: Record<string, unknown>): GqlObject {
  const input = inputObject(args);
  const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
  const repo = decoded?.kind === 'R' ? findRepoById(forge, decoded.numericId) : null;
  if (repo === null) throw new GraphQLError('Could not resolve to a Repository with the global id.');
  const title = String(input.title ?? '');
  const baseRefName = String(input.baseRefName ?? repo.defaultBranch);
  const headRefName = String(input.headRefName ?? '');
  const pull = forge.createPull(repo, title, '', headRefName, baseRefName);
  if (pull === null) throw new GraphQLError('Could not create the pull request.');
  return { __typename: 'CreatePullRequestPayload', pullRequest: pullObject(repo, pull) };
}

function mergePullRequestMutation(forge: Forge, args: Record<string, unknown>): GqlObject {
  const input = inputObject(args);
  const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
  const found = decoded?.kind === 'PR' ? findPullById(forge, decoded.numericId) : null;
  if (found === null) throw new GraphQLError('Could not resolve to a PullRequest with the global id.');
  const { repo, pull } = found;
  if (pull.state !== 'open' || pull.merged) throw new GraphQLError('Pull request is already closed.');
  const mergeOid = forge.squashMerge(repo, pull);
  if (mergeOid === null) throw new GraphQLError('Merge conflict.');
  pull.merged = true;
  pull.state = 'closed';
  pull.merge_commit_sha = mergeOid;
  pull.merged_at = forge.timestamp().iso;
  pull.updatedSeq = forge.advanceSeq();
  return { __typename: 'MergePullRequestPayload', pullRequest: pullObject(repo, pull) };
}

function addCommentMutation(forge: Forge, args: Record<string, unknown>): GqlObject {
  const input = inputObject(args);
  const decoded = decodeGlobalId(String(input.subjectId ?? ''));
  const body = String(input.body ?? '');
  if (decoded?.kind === 'I') {
    const found = findIssueById(forge, decoded.numericId);
    if (found !== null) {
      const comment: IssueComment = { id: found.repo.nextCommentId++, body, createdSeq: forge.advanceSeq() };
      found.issue.comments.push(comment);
      return {
        __typename: 'AddCommentPayload',
        commentEdge: { __typename: 'IssueEdge', node: commentObject(found.repo, found.issue, comment), cursor: '' } as GqlObject,
      };
    }
  }
  throw new GraphQLError('Could not resolve to an Issue with the global id.');
}

// ---------------------------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------------------------

function isGqlObject(value: unknown): value is GqlObject {
  return typeof value === 'object' && value !== null && '__typename' in (value as Record<string, unknown>);
}

function completeValue(
  forge: Forge,
  value: unknown,
  selections: Selection[],
  fragments: Map<string, Fragment>,
  variables: Record<string, unknown>,
): unknown {
  if (value === null || value === undefined) return null;
  if (selections.length === 0) return value;
  if (Array.isArray(value)) {
    return value.map((entry) => completeValue(forge, entry, selections, fragments, variables));
  }
  if (isGqlObject(value)) {
    return executeSelectionSet(forge, value, selections, fragments, variables);
  }
  return value;
}

function executeSelectionSet(
  forge: Forge,
  parent: GqlObject,
  selections: Selection[],
  fragments: Map<string, Fragment>,
  variables: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'field') {
      const args: Record<string, unknown> = {};
      for (const [key, node] of Object.entries(selection.args)) args[key] = resolveValue(node, variables);
      const value = resolveField(forge, parent, selection.name, args);
      out[selection.alias ?? selection.name] = completeValue(forge, value, selection.selections, fragments, variables);
    } else if (selection.kind === 'fragmentSpread') {
      const fragment = fragments.get(selection.name);
      if (fragment === undefined) throw new GraphQLError(`Unknown fragment "${selection.name}".`);
      if (fragment.typeCondition !== parent.__typename) continue;
      Object.assign(out, executeSelectionSet(forge, parent, fragment.selections, fragments, variables));
    } else if (selection.kind === 'inlineFragment') {
      if (selection.typeCondition !== null && selection.typeCondition !== parent.__typename) continue;
      Object.assign(out, executeSelectionSet(forge, parent, selection.selections, fragments, variables));
    }
  }
  return out;
}

export interface GraphQLResult {
  data?: Record<string, unknown> | null;
  errors?: Array<{ message: string }>;
}

function executeOperation(
  forge: Forge,
  document: { operations: Operation[]; fragments: Map<string, Fragment> },
  operationName: string | null | undefined,
  variables: Record<string, unknown>,
): GraphQLResult {
  let operation = document.operations[0]!;
  if (operationName !== null && operationName !== undefined) {
    const named = document.operations.find((entry) => entry.name === operationName);
    if (named !== undefined) operation = named;
  }
  const root: GqlObject = operation.operation === 'mutation' ? { __typename: 'Mutation' } : { __typename: 'Query' };
  try {
    const data = executeSelectionSet(forge, root, operation.selections, document.fragments, variables);
    return { data };
  } catch (err) {
    if (err instanceof GraphQLError) return { data: null, errors: [{ message: err.message }] };
    throw err;
  }
}

/** Execute one parsed body ({query, variables, operationName}) or a batch array of them. */
export function handleGraphQL(forge: Forge, body: unknown): GraphQLResult | GraphQLResult[] {
  if (Array.isArray(body)) {
    return body.map((entry) => handleGraphQL(forge, entry) as GraphQLResult);
  }
  if (body === null || typeof body !== 'object') {
    return { data: null, errors: [{ message: 'The GraphQL body must be an object.' }] };
  }
  const record = body as Record<string, unknown>;
  const query = record.query;
  if (typeof query !== 'string') {
    return { data: null, errors: [{ message: 'The GraphQL body must hold a query string.' }] };
  }
  const variables = (record.variables ?? {}) as Record<string, unknown>;
  const operationName = typeof record.operationName === 'string' ? record.operationName : null;
  let document: { operations: Operation[]; fragments: Map<string, Fragment> };
  try {
    document = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    if (err instanceof GraphQLError) return { data: null, errors: [{ message: err.message }] };
    throw err;
  }
  return executeOperation(forge, document, operationName, variables);
}
