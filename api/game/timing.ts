import type { GameStatus } from "../../contracts/game";

export interface GameTiming {
  accumulatedMs: number;
  startedAt: number | null;
  runningSince: number | null;
  endedAt: number | null;
  /** 最近一次实时落库时刻；恢复时只结算到这里，避免把停机时间计入。 */
  savedAt: number;
}

export function initialGameTiming(): GameTiming {
  return { accumulatedMs: 0, startedAt: null, runningSince: null, endedAt: null, savedAt: 0 };
}

export function startTiming(t: GameTiming, now: number): GameTiming {
  if (t.endedAt != null) return t;
  return {
    ...t,
    startedAt: t.startedAt ?? now,
    runningSince: t.runningSince ?? now,
    savedAt: now,
  };
}

export function pauseTiming(t: GameTiming, now: number): GameTiming {
  return {
    ...t,
    accumulatedMs: t.runningSince == null
      ? t.accumulatedMs
      : t.accumulatedMs + Math.max(0, now - t.runningSince),
    runningSince: null,
    savedAt: now,
  };
}

export function finishTiming(t: GameTiming, now: number): GameTiming {
  const paused = pauseTiming(t, now);
  return { ...paused, endedAt: paused.endedAt ?? now };
}

export function elapsedAt(t: GameTiming, now: number): number {
  return t.accumulatedMs + (t.runningSince == null ? 0 : Math.max(0, now - t.runningSince));
}

export function restoreTiming(t: GameTiming, status: GameStatus, now: number): GameTiming {
  let restored = t.runningSince == null
    ? { ...t, savedAt: now }
    : {
        ...t,
        accumulatedMs: t.accumulatedMs + Math.max(0, t.savedAt - t.runningSince),
        runningSince: status === "running" ? now : null,
        savedAt: now,
      };
  if (status === "finished" && restored.endedAt == null) {
    restored = { ...restored, endedAt: t.savedAt || now, runningSince: null };
  }
  return restored;
}
