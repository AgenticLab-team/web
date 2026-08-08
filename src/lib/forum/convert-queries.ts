import "server-only";

import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { postSources } from "@/lib/db/schema";

export interface ConsentEntry {
  wxId: string;
  status: "pending" | "granted" | "denied";
}

export interface ConsentSummary {
  isConverted: boolean;
  convId: string | null;
  total: number;
  granted: number;
  denied: number;
  pending: number;
  /** 当前查看者是否需要表态，以及表过没有 */
  myStatus: ConsentEntry["status"] | null;
  canRaise: boolean;
}

/**
 * 群聊转帖的同意状态。
 *
 * 「多数同意」在这里不成立 —— 被拒绝的那个人的发言依然会被公开，
 * 所以必须**全体同意**才能提升可见性，有一人拒绝即整体拒绝。
 */
export function consentSummary(postId: string, viewerWxId: string | null): ConsentSummary {
  const source = db.select().from(postSources).where(eq(postSources.postId, postId)).get();
  if (!source) {
    return {
      isConverted: false,
      convId: null,
      total: 0,
      granted: 0,
      denied: 0,
      pending: 0,
      myStatus: null,
      canRaise: false,
    };
  }

  const log = (source.consentLog as ConsentEntry[] | null) ?? [];
  const granted = log.filter((e) => e.status === "granted").length;
  const denied = log.filter((e) => e.status === "denied").length;
  const pending = log.filter((e) => e.status === "pending").length;

  return {
    isConverted: true,
    convId: source.convId,
    total: log.length,
    granted,
    denied,
    pending,
    myStatus: viewerWxId ? (log.find((e) => e.wxId === viewerWxId)?.status ?? null) : null,
    canRaise: log.length > 0 && granted === log.length,
  };
}
