/**
 * 人格关系详情面板
 *
 * 三段结构：
 *   ① 人格名标签（谁看谁）——方向可切换（A→B / B→A），默认视角 = 聚焦者（P0-13）
 *   ② 关系详情卡片（L2 主观层：雷达 + 自评）——报告/原始答卷/发起测评入口（P0-12）
 *   ③ 现实层时间线（L1：原世界补完 + 山谷对局变动）——手录增改删入口（P1-4）
 *
 * 视图：全部 / 原世界 / 山谷   ·   排序：正序 / 倒序
 * 设计铁律：现实层只显示这个人的视角；面板不遮挡画布。
 * 面板内部状态（view/order）由父级 key 重置，不跨关系残留（P2-21）。
 */
import { useMemo, useState } from "react";
import {
  ArrowLeftRight,
  ChevronRight,
  ClipboardPen,
  Loader2,
  Plus,
  RotateCcw,
  X,
  ArrowDownWideNarrow,
  ArrowUpNarrowWide,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { RelationCard, type RelationCardProps } from "./RelationCard";
import { CanonTimeline, type CanonItem, type TimelineSource } from "./CanonTimeline";

/** 山谷关系变动（来自对局历史）*/
export interface ValleyItem {
  id: number;
  era: string;
  relation: string;
  affinityDelta: number;
  trustDelta: number;
  note: string | null;
  titleNo: string;
}

/** 山谷变动 → 时间线项 */
function valleyToCanon(v: ValleyItem): CanonItem {
  const d = (n: number) => (n > 0 ? "+" + n : String(n));
  return {
    id: v.id,
    seq: v.id,
    era: v.era,
    age: null,
    place: null,
    eraBasis: null,
    eventText: v.relation + "（好感 " + d(v.affinityDelta) + " · 信任 " + d(v.trustDelta) + "）",
    feeling: v.note ?? "（这一局没有留下心理记录）",
    impact: null,
    certainty: "stated",
    verification: "manual",
    origin: "valley",
    source: "valley",
  };
}

/**
 * 时间排序键。
 *
 * ★ 历史 bug：旧实现只取 4 位年份，把「2006年夏」「2006年8月」「2006年」全部
 *   压成「2006-00-00」，同一年的事件排序变成随机 —— 时间线看起来是乱序的。
 *
 * 现在解析到「年-月-日」：
 *   · 有「N月」「N日」用具体数字
 *   · 「春/夏/秋/冬」映射到 3/6/9/12 月
 *   · 只有年份 → 月日为 00（排在该年最前，符合「只知道年」的精度）
 *   · 完全无年份（时期不明/未明确）→ 排最后
 */
function timeKey(item: Pick<CanonItem, "era">): string {
  const s = String(item.era || "");
  const y = s.match(/(\d{4})/);
  if (!y) return "9999-99-99";
  const mo = s.match(/(\d{1,2})\s*月/);
  const dd = s.match(/(\d{1,2})\s*日/);
  // 「N月后」「N年末」「之后」表示该时段的末尾 → 用 month=13 表示"年末之后"
  const isLate = /(末|底|后|之后|以后)\s*$/.test(s.trim());
  let month = mo ? Number(mo[1]) : 0;
  if (!month) {
    if (/春/.test(s)) month = 3;
    else if (/夏/.test(s)) month = 6;
    else if (/秋/.test(s)) month = 9;
    else if (/冬/.test(s)) month = 12;
  }
  // 年末/月后 → 排到该年（或该月之后）最后
  if (isLate) month = month > 0 ? month + 1 : 13;
  const pad = (n: number) => String(n).padStart(2, "0");
  // month=13 时直接输出 "13"，保证排在 12 之后
  return y[1] + "-" + pad(month) + "-" + pad(dd && !isLate ? Number(dd[1]) : 0);
}

/** 单个方向（视角）的数据 */
export interface RelationDirectionView {
  fromName: string;
  toName: string;
  card: Omit<RelationCardProps, "fromName" | "toName"> | null;
  /** 原世界现实层 */
  canonItems: CanonItem[];
  /** 山谷对局变动 */
  valleyItems: ValleyItem[];
}

export interface RelationDetailPanelProps {
  /** 当前视角的数据（from 看 to） */
  direction: RelationDirectionView;
  /** 反方向是否有记录（切换按钮的提示点） */
  otherHasData?: boolean;
  /** 切换到反方向视角（唯一视角切换入口；不点击人格名） */
  onFlipPerspective?: () => void;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  onClose?: () => void;
  onOpenReport?: () => void;
  onOpenAnswers?: () => void;
  onStartRSQ?: () => void;
  onEditCanon?: (item: CanonItem) => void;
  onDeleteCanon?: (id: number) => void;
  onAddCanon?: () => void;
  /** 原世界事件拖动排序（view=canon 时可用） */
  onReorderCanon?: (orderedIds: number[]) => void | Promise<void>;
  canonReordering?: boolean;
  onBackfill?: () => void;
  backfillRunning?: boolean;
  /** 补完用哪个 API（显示当前 API，P1-18）；null=未配置 */
  backfillApiName?: string | null;
  /** 双向补完进度文本（每方向独立状态，P1-18） */
  backfillStatusText?: string | null;
  className?: string;
}

type ViewMode = "all" | "canon" | "valley";
type SortOrder = "asc" | "desc";

export function RelationDetailPanel(props: RelationDetailPanelProps) {
  const {
    direction, otherHasData = false, onFlipPerspective, loading, error, onRetry, onClose,
    onOpenReport, onOpenAnswers, onStartRSQ,
    onEditCanon, onDeleteCanon, onAddCanon,
    onReorderCanon, canonReordering,
    onBackfill, backfillRunning, backfillApiName, backfillStatusText, className,
  } = props;
  const { fromName, toName, card, canonItems, valleyItems } = direction;

  const [view, setView] = useState<ViewMode>("all");
  const [order, setOrder] = useState<SortOrder>("asc");

  const merged = useMemo(() => {
    const canon: CanonItem[] = canonItems.map((x) => ({ ...x, source: "canon" as TimelineSource }));
    const valley: CanonItem[] = valleyItems.map(valleyToCanon);
    const all = [...canon, ...valley];
    const filtered = view === "all" ? all : all.filter((x) => x.source === view);
    const manualCanon = view === "canon" && canon.some((x) => x.sortOrder != null);
    filtered.sort((a, b) => {
      if (manualCanon) {
        const av = a.sortOrder ?? Number.MAX_SAFE_INTEGER;
        const bv = b.sortOrder ?? Number.MAX_SAFE_INTEGER;
        if (av !== bv) return (av - bv) * (order === "asc" ? 1 : -1);
      }
      return (timeKey(a) < timeKey(b) ? -1 : timeKey(a) > timeKey(b) ? 1 : 0) * (order === "asc" ? 1 : -1);
    });
    return filtered;
  }, [canonItems, valleyItems, view, order]);

  const canonCount = canonItems.length;
  const valleyCount = valleyItems.length;
  const total = canonCount + valleyCount;

  return (
    <div className={cn("flex h-full flex-col", className)}>
      {/* ① 人格名标签 + 换视角按钮（用户要求：不点击名字，只保留「换视角」键） */}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border/60 px-4 py-2.5">
        <span className="min-w-0 truncate text-[13px] font-medium tracking-wide text-foreground">{fromName}</span>
        <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/50" aria-hidden />
        <span className="min-w-0 truncate text-[13px] font-medium tracking-wide text-foreground">{toName}</span>
        {onFlipPerspective ? (
          <button
            type="button"
            onClick={onFlipPerspective}
            className="ml-auto inline-flex shrink-0 items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title={otherHasData ? '切换到反方向视角（对方也有记录）' : '切换到反方向视角（当前对方视角为空）'}
            aria-label="切换关系视角"
          >
            <ArrowLeftRight className="h-3 w-3" aria-hidden />
            换视角
            {otherHasData ? <span className="ml-0.5 h-1.5 w-1.5 rounded-full bg-primary" aria-hidden /> : null}
          </button>
        ) : null}
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            className={cn(
              'shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
              onFlipPerspective ? 'ml-1' : 'ml-auto',
            )}
            aria-label="关闭详情面板"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* 加载 / 错误 / 内容 */}
        {loading && !card && canonCount === 0 && valleyCount === 0 ? (
          <p className="flex items-center justify-center gap-2 py-10 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> 正在加载视角数据…
          </p>
        ) : null}
        {error ? (
          <div className="space-y-2 px-3 py-6 text-center">
            <p className="text-xs text-wolf">{error}</p>
            {onRetry ? (
              <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={onRetry}>
                <RotateCcw className="mr-1 h-3 w-3" /> 重试
              </Button>
            ) : null}
          </div>
        ) : null}

        {!error && !(loading && !card && canonCount === 0 && valleyCount === 0) ? (
          <>
            {/* ② 关系详情卡片 */}
            <div className="border-b border-border/60 p-3">
              {card ? (
                <RelationCard
                  fromName={fromName}
                  toName={toName}
                  {...card}
                  onOpenDetail={onOpenReport}
                  onOpenAnswers={onOpenAnswers}
                />
              ) : (
                <div className="flex flex-col items-center justify-center gap-2 py-5 text-center">
                  <p className="text-[11px] text-muted-foreground/60">还没有对这个人的关系测评</p>
                  {onStartRSQ ? (
                    <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={onStartRSQ}>
                      <ClipboardPen className="mr-1 h-3 w-3" /> 填写关系测评（RSQ）
                    </Button>
                  ) : null}
                </div>
              )}
              {card && onStartRSQ ? (
                <div className="mt-1.5 flex justify-end">
                  <button
                    type="button"
                    onClick={onStartRSQ}
                    className="text-[10px] text-muted-foreground/60 underline-offset-2 hover:text-foreground hover:underline"
                  >
                    重新测评
                  </button>
                </div>
              ) : null}
            </div>

            {/* ③ 时间线：视图 + 排序 */}
            <div className="p-3">
              <div className="mb-2 flex flex-wrap items-center gap-1">
                {/* 视图切换 */}
                <div className="flex gap-0.5 rounded-md border border-border/70 bg-accent/20 p-0.5">
                  {([
                    ["all", "全部", total],
                    ["canon", "原世界", canonCount],
                    ["valley", "山谷", valleyCount],
                  ] as Array<[ViewMode, string, number]>).map(([v, label, n]) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => setView(v)}
                      className={cn(
                        "rounded px-1.5 py-0.5 text-[10px] transition-colors",
                        view === v ? "bg-background font-medium text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {label}
                      <span className="ml-0.5 text-muted-foreground/60">{n}</span>
                    </button>
                  ))}
                </div>

                {/* 排序切换 */}
                <button
                  type="button"
                  onClick={() => setOrder(order === "asc" ? "desc" : "asc")}
                  className="ml-auto inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
                  title={order === "asc" ? "当前：时间正序，点击切倒序" : "当前：时间倒序，点击切正序"}
                >
                  {order === "asc" ? <ArrowUpNarrowWide className="h-3 w-3" /> : <ArrowDownWideNarrow className="h-3 w-3" />}
                  {order === "asc" ? "正序" : "倒序"}
                </button>
              </div>

              {onAddCanon ? (
                <div className="mb-2 flex justify-end">
                  <button
                    type="button"
                    onClick={onAddCanon}
                    className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  >
                    <Plus className="h-3 w-3" aria-hidden /> 手动补充一条
                  </button>
                </div>
              ) : null}

              {merged.length > 0 ? (
                <CanonTimeline
                  items={merged}
                  toName={toName}
                  onEdit={onEditCanon}
                  onDelete={onDeleteCanon}
                  onAdd={onAddCanon}
                  reorderable={view === "canon" && !!onReorderCanon && canonCount > 1}
                  reordering={canonReordering}
                  onReorder={view === "canon" ? onReorderCanon : undefined}
                />
              ) : (
                <div className="flex flex-col items-center justify-center gap-2 py-8 text-center">
                  <p className="text-[11px] text-muted-foreground/60">
                    {view === "canon" ? "原世界还没有记忆记录" : view === "valley" ? "还没有对局变动记录" : "这里还没有任何记忆记录"}
                  </p>
                  {onAddCanon ? (
                    <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={onAddCanon}>
                      <Plus className="mr-1 h-3 w-3" /> 手动补充一条
                    </Button>
                  ) : null}
                </div>
              )}

              {/* 补完入口：原世界为空或偏少时提示；显示当前 API 与双向状态（P1-18） */}
              {onBackfill ? (
                <div className="mt-3 space-y-1">
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      onClick={onBackfill}
                      disabled={backfillRunning}
                      className="h-7 bg-emerald-600 text-[11px] text-white hover:bg-emerald-700"
                    >
                      {backfillRunning ? (
                        <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                      ) : (
                        <Plus className="mr-1 h-3 w-3" />
                      )}
                      {backfillRunning ? "正在补完…" : canonCount === 0 ? "补完原世界记忆" : "增量补完"}
                    </Button>
                    <span className="min-w-0 truncate text-[10px] text-muted-foreground/60">
                      {backfillApiName ? "当前 API：" + backfillApiName : "未配置 API"}
                    </span>
                  </div>
                  {backfillStatusText ? (
                    <p className="text-[10px] text-muted-foreground/70">{backfillStatusText}</p>
                  ) : null}
                </div>
              ) : null}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}