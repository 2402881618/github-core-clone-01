# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/2402881618/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/2402881618/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node 22 process, built for make.fun's
["Build a GitHub-compatible git forge"](https://make.fun/bounty/github-core-clone-01)
bounty ($500 in USDC). Everything lives in memory: no database, no disk writes
on the request path, so the hot paths stay fast.

What it serves:

- **Git smart HTTP** (`/{owner}/{repo}.git`): protocol v2 and v0 advertisements,
  `ls-refs`, `fetch` (including shallow/deepen and incremental fetches),
  `receive-pack` pushes with report-status, and byte-compatible packfiles
  (SHA-1 object model, OFS/REF delta unpacking).
- **REST v3** (`/api/v3`): repositories, branches, commits, git refs, contents,
  labels, issues, comments, pull requests and squash merges, with GitHub-style
  pagination (`Link` headers) and error shapes.
- **GraphQL** (`/api/graphql`): viewer, repository, issue and pull request
  reads, cursor pagination, `__type` introspection, Relay global ids, batching,
  and the create/close/merge/comment mutations — all on the same store as REST.
- **MCP** (`/mcp`): the 2026-07-28 `server/discover` era with the legacy
  `initialize` handshake as a fallback, and six tools (`create_repo`,
  `get_repo`, `create_issue`, `list_issues`, `create_pull_request`,
  `merge_pull_request`).

## Run it

Requires Node 22.18 or later. There is nothing to install: the program imports
`node:http` and its own modules only.

```sh
MAKEFUN_SHOP_TOKEN=<your token> node --experimental-strip-types main.ts
```

The server binds an ephemeral port and prints it. With `MAKEFUN_ENV_URL` set it
registers that port with the env and exits when the env says the trial is done;
without it, it simply serves until stopped. `MAKEFUN_SHOP_TOKEN` is the bearer
token the REST, GraphQL, MCP and git endpoints accept; with none configured, any
non-empty bearer is accepted (local development only).

## Layout

- `main.ts` — the boot lifecycle (bind, register, wait for done).
- `src/server.ts` — HTTP routing, auth and body handling.
- `src/git-core.ts` — the git object model, pkt-line framing and packfiles.
- `src/store.ts` — the in-memory forge (repos, refs, issues, pull requests).
- `src/git-http.ts` — the smart-HTTP surface.
- `src/rest.ts` — the REST v3 surface.
- `src/graphql.ts` — the GraphQL parser and executor.
- `src/mcp.ts` — the MCP endpoint and tools.
