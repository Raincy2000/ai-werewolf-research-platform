// ============================================================
// L2 持久层：调用台账（§30.10）
// ============================================================
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../queries/connection";
import { insertReturningId } from "../../queries/dialect";
import { invocationLog } from "../../../db/schema";
import type { SituationKind, InvokedItem, ResolvedConflict } from "../../../contracts/interpersonal";

export interface InvocationRecord {
  id?: number;
  gameId?: string | null;
  turn?: number | null;
  personaId: number;
  situationKind: SituationKind;
  invokedSources: InvokedItem[];
  truncated: InvokedItem[];
  conflictsResolved: ResolvedConflict[];
  contextHash: string;
  outputEventId?: number | null;
}

export async function insertInvocation(rec: InvocationRecord): Promise<number> {
  try {
    return await insertReturningId(invocationLog, {
      gameId: rec.gameId ?? null,
      turn: rec.turn ?? null,
      personaId: rec.personaId,
      situationKind: rec.situationKind,
      invokedSources: rec.invokedSources as never,
      truncated: rec.truncated as never,
      conflictsResolved: rec.conflictsResolved as never,
      contextHash: rec.contextHash,
      outputEventId: rec.outputEventId ?? null,
    });
  } catch {
    return 0;
  }
}

/** 决策落盘后回填产出事件 id（§30.10 台账可复盘） */
export async function updateInvocationOutput(logId: number, eventId: number | null): Promise<void> {
  if (!logId) return;
  const db = getDb();
  await db.update(invocationLog).set({ outputEventId: eventId ?? null } as never).where(eq(invocationLog.id, logId));
}

export async function listInvocations(gameId: string, personaId?: number) {
  const db = getDb();
  const conds = [eq(invocationLog.gameId, gameId)];
  if (personaId != null) conds.push(eq(invocationLog.personaId, personaId));
  return db
    .select()
    .from(invocationLog)
    .where(and(...conds))
    .orderBy(desc(invocationLog.createdAt));
}
