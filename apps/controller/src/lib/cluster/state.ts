/**
 * What this process is to the cluster. On globalThis: a dev program reload re-evaluates the
 * modules, and a second heartbeat or leader loop would hold a lock the first never lets go of.
 */
import { randomUUID } from "node:crypto";

export type LeaderJob = { name: string; start: () => void; stop: () => void };

export type MessageHandler = (data: unknown, from: string) => void;

type ClusterState = {
  replicaId: string;
  started: boolean;
  leader: boolean;
  jobs: LeaderJob[];
  heartbeat: ReturnType<typeof setInterval> | null;
  /** Last generation seen per announced name. */
  generations: Map<string, number>;
  handlers: Map<string, Set<() => void>>;
  messageHandlers: Map<string, Set<MessageHandler>>;
  /** Run on every heartbeat and when the listener reconnects, for whatever a NOTIFY may miss. */
  syncHooks: Set<() => Promise<void>>;
  /** Other live replicas at the last heartbeat; read where a query would be too slow. */
  peers: number;
};

const global = globalThis as typeof globalThis & { __cpmCluster?: Partial<ClusterState> };

// Field by field, so a reload after an upgrade fills in what an older copy lacks.
global.__cpmCluster ??= {};
const partial = global.__cpmCluster;
partial.replicaId ??= randomUUID();
partial.started ??= false;
partial.leader ??= false;
partial.jobs ??= [];
partial.heartbeat ??= null;
partial.generations ??= new Map();
partial.handlers ??= new Map();
partial.messageHandlers ??= new Map();
partial.syncHooks ??= new Set();
partial.peers ??= 0;

export const cluster = partial as ClusterState;

/** A replica missing this many heartbeats in a row counts as gone. */
export const HEARTBEAT_MS = 10_000;
export const REPLICA_LIVE_MS = 3 * HEARTBEAT_MS;
