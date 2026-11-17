// git-http.ts — the smart-HTTP surface: info/refs advertisements (v0/v2),
// v2 ls-refs and fetch, v0 fetch, and v0 receive-pack with report-status.

import { Buffer } from 'node:buffer';
import {
  ZERO_OID,
  buildTree,
  collectReachable,
  decodePktLines,
  encodePktLines,
  hashObject,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  pktDelim,
  pktFlush,
  pktLine,
  readPack,
  sidebandFrame,
  writePack,
  type GitObject,
  type GitPacket,
} from './git-core.ts';
import { DEFAULT_BRANCH, VIEWER_LOGIN, type Forge, type Repo } from './store.ts';

const AGENT = 'forge/1.0';

export interface GitHttpResult {
  status: number;
  contentType: string;
  body: Buffer;
}

function jsonError(status: number, message: string): GitHttpResult {
  return {
    status,
    contentType: 'application/json',
    body: Buffer.from(JSON.stringify({ message }), 'utf8'),
  };
}

function findRepo(forge: Forge, owner: string, name: string): Repo | null {
  if (owner !== VIEWER_LOGIN) return null;
  return forge.getRepo(owner, name) ?? null;
}

/** All refs of a repo, sorted: heads first, then tags. */
function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  const refs = [...repo.refs.entries()].map(([name, oid]) => ({ name, oid }));
  refs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return refs;
}

/** The peeled commit for an annotated tag ref, or undefined. */
function peeledOf(forge: Forge, repo: Repo, oid: string): string | undefined {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'tag') return undefined;
  return forge.peelToCommit(repo, parseTag(object.data).object);
}

// ---------------------------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------------------------

function v2Advertisement(): Buffer {
  return Buffer.concat([
    pktLine('# service=git-upload-pack\n'),
    pktFlush,
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow filter\n'),
    pktLine('object-format=sha1\n'),
    pktFlush,
  ]);
}

function v0Advertisement(forge: Forge, repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps =
    service === 'git-upload-pack'
      ? `symref=HEAD:refs/heads/${DEFAULT_BRANCH} side-band-64k thin-pack ofs-delta multi_ack_detailed shallow agent=${AGENT}`
      : `symref=HEAD:refs/heads/${DEFAULT_BRANCH} report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush];
  const refs = sortedRefs(repo);
  const lines: string[] = [];
  const mainTip = repo.refs.get(`refs/heads/${DEFAULT_BRANCH}`);
  if (mainTip !== undefined) lines.push(`${mainTip} HEAD`);
  for (const ref of refs) {
    lines.push(`${ref.oid} ${ref.name}`);
    const peeled = peeledOf(forge, repo, ref.oid);
    if (peeled !== undefined) lines.push(`${peeled} ${ref.name}^{}`);
  }
  if (lines.length === 0) lines.push(`${ZERO_OID} capabilities^{}`);
  lines.forEach((line, index) => {
    parts.push(pktLine(index === 0 ? `${line}\0${caps}\n` : `${line}\n`));
  });
  parts.push(pktFlush);
  return Buffer.concat(parts);
}

export function handleInfoRefs(
  forge: Forge,
  owner: string,
  repoName: string,
  service: 'git-upload-pack' | 'git-receive-pack',
  gitProtocol: string | null,
): GitHttpResult {
  const repo = findRepo(forge, owner, repoName);
  if (repo === null) return jsonError(404, 'Not Found');
  const contentType = `application/x-${service}-advertisement`;
  if (service === 'git-upload-pack' && gitProtocol === 'version=2') {
    return { status: 200, contentType, body: v2Advertisement() };
  }
  return { status: 200, contentType, body: v0Advertisement(forge, repo, service) };
}

// ---------------------------------------------------------------------------------------------
// v2 ls-refs
// ---------------------------------------------------------------------------------------------

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function parseLsRefsArgs(packets: GitPacket[]): LsRefsArgs {
  const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  let seenDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!seenDelim) continue; // command=/agent=/object-format= lines
    if (line === 'peel') args.peel = true;
    else if (line === 'symrefs') args.symrefs = true;
    else if (line === 'unborn') args.unborn = true;
    else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
  }
  return args;
}

function handleLsRefs(forge: Forge, repo: Repo, body: Buffer): GitHttpResult {
  let packets: GitPacket[];
  try {
    packets = decodePktLines(body);
  } catch (err) {
    return jsonError(400, `malformed pkt-line: ${(err as Error).message}`);
  }
  const args = parseLsRefsArgs(packets);
  const lines: string[] = [];
  const mainTip = repo.refs.get(`refs/heads/${DEFAULT_BRANCH}`);
  const headMatches = args.prefixes.length === 0 || args.prefixes.some((p) => 'HEAD'.startsWith(p) || p.startsWith('HEAD'));
  if (headMatches) {
    if (mainTip !== undefined) {
      lines.push(args.symrefs ? `${mainTip} HEAD symref-target:refs/heads/${DEFAULT_BRANCH}\n` : `${mainTip} HEAD\n`);
    } else if (args.unborn) {
      lines.push(`unborn HEAD symref-target:refs/heads/${DEFAULT_BRANCH}\n`);
    }
  }
  for (const ref of sortedRefs(repo)) {
    if (args.prefixes.length > 0 && !args.prefixes.some((p) => ref.name.startsWith(p))) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (args.peel) {
      const peeled = peeledOf(forge, repo, ref.oid);
      if (peeled !== undefined) line += ` peeled:${peeled}`;
    }
    lines.push(`${line}\n`);
  }
  const parts = lines.map((line) => pktLine(line));
  parts.push(pktFlush);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

// ---------------------------------------------------------------------------------------------
// fetch computation
// ---------------------------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

/** Reachable objects from `roots`, treating `shallowSet` commits as leaves (no parents). */
function reachableWithShallow(
  repo: Repo,
  roots: Iterable<string>,
  shallowSet: ReadonlySet<string>,
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isObjectId(root)) queue.push(root);
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      if (!shallowSet.has(oid)) for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}

interface FetchPlan {
  /** Objects to send. */
  send: Map<string, GitObject>;
  /** New shallow boundaries (commits at exactly the depth limit). */
  shallow: string[];
  /** Former shallow boundaries that are no longer shallow. */
  unshallow: string[];
  /** Have oids that exist in the repo. */
  acks: string[];
}

function computeFetch(repo: Repo, args: FetchArgs): FetchPlan {
  const shallowSet = new Set(args.shallow);
  const haveSet = reachableWithShallow(repo, args.haves, shallowSet);
  const acks = args.haves.filter((oid) => repo.objects.has(oid));

  // Walk commits from the wants, tracking depth (want commits are depth 1).
  const walked = new Set<string>();
  const commitDepth = new Map<string, number>();
  const newShallow = new Set<string>();
  const queue: Array<{ oid: string; depth: number }> = [];
  for (const want of args.wants) {
    const object = repo.objects.get(want);
    if (!object) continue;
    if (object.type === 'tag') {
      walked.add(want);
      const target = parseTag(object.data).object;
      queue.push({ oid: target, depth: 1 });
    } else if (object.type === 'commit') {
      queue.push({ oid: want, depth: 1 });
    } else {
      walked.add(want);
    }
  }
  while (queue.length) {
    const { oid, depth } = queue.shift()!;
    if (commitDepth.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    commitDepth.set(oid, depth);
    const commit = parseCommit(object.data);
    if (args.depth !== null && depth >= args.depth) {
      newShallow.add(oid);
      continue; // do not walk parents, but still include this commit's tree below
    }
    for (const parent of commit.parents) queue.push({ oid: parent, depth: depth + 1 });
  }
  // Include every walked commit's full tree closure.
  for (const oid of commitDepth.keys()) {
    const commit = parseCommit(repo.objects.get(oid)!.data);
    for (const reached of collectReachable([commit.tree], (o) => repo.objects.get(o), { allowMissing: true })) {
      walked.add(reached);
    }
    walked.add(oid);
  }

  const send = new Map<string, GitObject>();
  for (const oid of walked) {
    if (haveSet.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object) send.set(oid, object);
  }

  const unshallow: string[] = [];
  for (const oid of args.shallow) {
    const depth = commitDepth.get(oid);
    if (depth === undefined) continue;
    if (args.depth === null || depth < args.depth) unshallow.push(oid);
  }

  return { send, shallow: [...newShallow], unshallow, acks };
}

function parseFetchArgsV2(packets: GitPacket[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null };
  let seenDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!seenDelim) continue;
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) args.depth = n;
    }
    // thin-pack, no-progress, ofs-delta, filter, deepen-since, deepen-not, done: accepted, ignored
  }
  args.wants = [...new Set(args.wants)];
  args.haves = [...new Set(args.haves)];
  args.shallow = [...new Set(args.shallow)];
  return args;
}

function fetchResponseV2(repo: Repo, args: FetchArgs): Buffer {
  const plan = computeFetch(repo, args);
  const parts: Buffer[] = [];
  if (args.haves.length > 0) {
    parts.push(pktLine('acknowledgments\n'));
    if (plan.acks.length > 0) {
      for (const oid of plan.acks) parts.push(pktLine(`ACK ${oid}\n`));
      parts.push(pktLine('ready\n'));
    } else {
      parts.push(pktLine('NAK\n'));
    }
    parts.push(pktDelim);
  }
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim);
  }
  const wantedRefs: string[] = [];
  for (const want of args.wants) {
    for (const [name, oid] of repo.refs) {
      if (oid === want) wantedRefs.push(`${want} ${name}\n`);
    }
  }
  if (wantedRefs.length > 0) {
    parts.push(pktLine('wanted-refs\n'));
    for (const line of wantedRefs) parts.push(pktLine(line));
    parts.push(pktDelim);
  }
  if (plan.send.size > 0) {
    const pack = writePack(plan.send.values());
    parts.push(pktLine('packfile\n'));
    parts.push(sidebandFrame(pack, 1));
  }
  parts.push(pktFlush);
  return Buffer.concat(parts);
}

function parseFetchArgsV0(packets: GitPacket[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null };
  let seenFlush = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      seenFlush = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!seenFlush) {
      if (line.startsWith('want ')) {
        const rest = line.slice(5).trim();
        const oid = rest.split(' ')[0]!;
        args.wants.push(oid);
      } else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) {
        const n = Number.parseInt(line.slice(7).trim(), 10);
        if (Number.isFinite(n) && n > 0) args.depth = n;
      }
    } else {
      if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    }
  }
  args.wants = [...new Set(args.wants)];
  args.haves = [...new Set(args.haves)];
  args.shallow = [...new Set(args.shallow)];
  return args;
}

function fetchResponseV0(repo: Repo, args: FetchArgs): Buffer {
  const plan = computeFetch(repo, args);
  const parts: Buffer[] = [];
  if (plan.acks.length > 0) {
    for (const oid of plan.acks) parts.push(pktLine(`ACK ${oid}\n`));
  } else if (args.haves.length > 0) {
    parts.push(pktLine('NAK\n'));
  }
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (plan.send.size > 0) {
    const pack = writePack(plan.send.values());
    parts.push(sidebandFrame(pack, 1));
  }
  parts.push(pktFlush);
  return Buffer.concat(parts);
}

export function handleUploadPack(
  forge: Forge,
  owner: string,
  repoName: string,
  body: Buffer,
  gitProtocol: string | null,
): GitHttpResult {
  const repo = findRepo(forge, owner, repoName);
  if (repo === null) return jsonError(404, 'Not Found');
  let packets: GitPacket[];
  try {
    packets = decodePktLines(body);
  } catch (err) {
    return jsonError(400, `malformed pkt-line: ${(err as Error).message}`);
  }
  const firstLine = packets.find((p) => p.kind === 'data')?.payload.toString('utf8').replace(/\n$/, '') ?? '';
  if (gitProtocol === 'version=2' || firstLine.startsWith('command=')) {
    if (firstLine.startsWith('command=ls-refs')) {
      return handleLsRefs(forge, repo, body);
    }
    if (firstLine.startsWith('command=fetch')) {
      const args = parseFetchArgsV2(packets);
      return {
        status: 200,
        contentType: 'application/x-git-upload-pack-result',
        body: fetchResponseV2(repo, args),
      };
    }
    return jsonError(400, `unknown v2 command ${JSON.stringify(firstLine)}`);
  }
  // Protocol v0 fetch.
  const args = parseFetchArgsV0(packets);
  return {
    status: 200,
    contentType: 'application/x-git-upload-pack-result',
    body: fetchResponseV0(repo, args),
  };
}

// ---------------------------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** Split a receive-pack body into its command pkt-lines and the pack that follows the flush. */
function splitReceivePack(body: Buffer): { commands: PushCommand[]; pack: Buffer | null } {
  let offset = 0;
  const commands: PushCommand[] = [];
  let pack: Buffer | null = null;
  while (offset < body.length) {
    if (offset + 4 > body.length) throw new Error('truncated pkt-line in receive-pack');
    const header = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`invalid pkt-line length ${JSON.stringify(header)}`);
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      offset += 4;
      pack = body.subarray(offset);
      break;
    }
    if (length < 4 || offset + length > body.length) throw new Error('truncated pkt-line in receive-pack');
    const payload = body.subarray(offset + 4, offset + length).toString('utf8');
    const nul = payload.indexOf('\0');
    const line = (nul >= 0 ? payload.slice(0, nul) : payload).replace(/\n$/, '');
    const parts = line.split(' ');
    if (parts.length < 3) throw new Error(`bad receive-pack command ${JSON.stringify(line)}`);
    commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts.slice(2).join(' ') });
    offset += length;
  }
  return { commands, pack };
}

function isValidRefName(ref: string): boolean {
  if (!ref.startsWith('refs/') || ref.length > 200) return false;
  if (/[\s\u0000-\u001f~^:?*[\\]/.test(ref)) return false;
  if (ref.includes('..') || ref.endsWith('.lock') || ref.endsWith('/') || ref.endsWith('.')) return false;
  return true;
}

export function handleReceivePack(
  forge: Forge,
  owner: string,
  repoName: string,
  body: Buffer,
): GitHttpResult {
  const repo = findRepo(forge, owner, repoName);
  if (repo === null) return jsonError(404, 'Not Found');
  let commands: PushCommand[];
  let pack: Buffer | null;
  try {
    ({ commands, pack } = splitReceivePack(body));
  } catch (err) {
    return jsonError(400, `malformed receive-pack: ${(err as Error).message}`);
  }
  if (commands.length === 0) return jsonError(400, 'receive-pack needs at least one command');

  // Unpack first; a failure is reported in the report-status stream, never a crash.
  let unpackOk = true;
  let unpackDetail = 'ok';
  const needsPack = commands.some((c) => c.newOid !== ZERO_OID);
  if (needsPack) {
    if (pack === null || pack.length === 0) {
      unpackOk = false;
      unpackDetail = 'unpacker error';
    } else {
      try {
        const read = readPack(pack, { resolveBase: (oid) => repo.objects.get(oid) });
        for (const [oid, object] of read.objects) {
          if (!repo.objects.has(oid)) repo.objects.set(oid, object);
        }
      } catch (err) {
        unpackOk = false;
        unpackDetail = (err as Error).message.slice(0, 120);
      }
    }
  }

  const reportLines: string[] = [`unpack ${unpackOk ? 'ok' : unpackDetail}\n`];
  for (const command of commands) {
    let ok = false;
    let reason = '';
    if (!unpackOk) {
      reason = 'unpack failed';
    } else if (!isValidRefName(command.ref)) {
      reason = 'invalid refname';
    } else {
      const current = repo.refs.get(command.ref);
      const isDelete = command.newOid === ZERO_OID;
      const isCreate = command.oldOid === ZERO_OID;
      if (isDelete) {
        if (current === undefined) reason = 'ref does not exist';
        else if (current !== command.oldOid) reason = 'non-fast-forward';
        else {
          repo.refs.delete(command.ref);
          ok = true;
        }
      } else if (isCreate) {
        if (current !== undefined) reason = 'already exists';
        else if (!repo.objects.has(command.newOid)) reason = 'object not found';
        else {
          repo.refs.set(command.ref, command.newOid);
          ok = true;
        }
      } else {
        if (current === undefined) reason = 'ref does not exist';
        else if (current !== command.oldOid) reason = 'non-fast-forward';
        else if (!repo.objects.has(command.newOid)) reason = 'object not found';
        else if (!forge.isAncestor(repo, command.oldOid, command.newOid)) reason = 'non-fast-forward';
        else {
          repo.refs.set(command.ref, command.newOid);
          ok = true;
        }
      }
    }
    reportLines.push(ok ? `ok ${command.ref}\n` : `ng ${command.ref} ${reason}\n`);
  }
  const reportInner = encodePktLines([...reportLines, 'flush']);
  const responseBody = Buffer.concat([sidebandFrame(reportInner, 1), pktFlush]);
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: responseBody };
}

// Re-exported for the store's tree helpers (kept here to avoid a cycle).
export { buildTree, hashObject };
