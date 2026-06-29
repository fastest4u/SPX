import { hostname } from "node:os";
import {
  releaseLease,
  renewLease,
  tryAcquireLease,
  upsertRuntimeNode,
  type LeaseAcquireResult,
} from "../repositories/runtime-repository.js";

export interface AcquireTeamLeaseInput {
  teamId: number;
  nodeId: string;
  role: string;
  ttlMs: number;
  now?: Date;
}

export interface RenewTeamLeaseInput {
  teamId: number;
  nodeId: string;
  leaseToken: string;
  ttlMs: number;
  now?: Date;
}

export interface ReleaseTeamLeaseInput {
  teamId: number;
  nodeId: string;
  leaseToken: string;
}

export async function acquireTeamLease(input: AcquireTeamLeaseInput): Promise<LeaseAcquireResult> {
  await upsertRuntimeNode({
    nodeId: input.nodeId,
    role: input.role,
    hostname: hostname(),
    pid: process.pid,
  });

  return await tryAcquireLease(input);
}

export async function renewTeamLease(input: RenewTeamLeaseInput): Promise<boolean> {
  return await renewLease(input);
}

export async function releaseTeamLease(input: ReleaseTeamLeaseInput): Promise<boolean> {
  return await releaseLease(input);
}
