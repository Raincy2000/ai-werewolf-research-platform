/**
 * RSQ 关系测评报告（含历史）
 *
 * 三级导航：
 *   关系卡片 ——「查看关系测评详情」→
 *   报告视图 —— 45 维 / 效度 / 原始答卷 / 作答反馈 /「查看历史测评结果」→
 *   历史视图 —— 过往测评卡片列表 —— 点任一张 → 该次报告（可返回列表）
 *
 * 审计修正（P1-22）：
 *  - 后端返回 `dims`（不是 `dimensions`）；
 *  - 实际 45 维（不是 39 维）；
 *  - 119 道计分题 + 第 120 题 selfSummary（不是「120 题原始答案」）；
 *  - derived 中文名；validity 逐字段兜底，旧记录不崩。
 *
 * 全部数据经 props 传入（RSQReportData 由 @/lib/rsqClient 的 toReportData 适配），
 * 不直接依赖后端类型（便于预览与测试）。
 */
import { useMemo, useState } from "react";
import { ChevronLeft, ClipboardList, History } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  RSQ_DERIVED_LABELS,
  RSQ_DIM_GROUPS,
  RSQ_FLAG_LABELS,
  RSQ_SCORED_ITEM_COUNT,
  RSQ_SELF_SUMMARY_NO,
  RSQ_VERDICT_LABEL,
  formatAnsweredAt,
  scoredAnswerCount,
  type RSQReportData,
  type RsqVerdict,
} from "@/lib/rsqClient";
import { RelationCard } from "./RelationCard";
import type { RadarDatum } from "./RelationRadar";

export type { RSQReportData };

export interface RSQReportDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  fromName: string;
  toName: string;
  /** 历史记录（由上层用 toReportData 适配；内部会按时间降序排）*/
  records: RSQReportData[];
  /** 初始展示哪一条（缺省 = 最新）*/
  initialId?: number;
  className?: string;
}

function ValidityRow({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 border-b border-border/30 py-1 last:border-0">
      <span className="text-[11px] text-muted-foreground/80">{label}</span>
      <span className="text-[11px] font-medium tabular-nums text-foreground/90">
        {value}
        {hint ? <span className="ml-1 text-[9px] font-normal text-muted-foreground/60">{hint}</span> : null}
      </span>
    </div>
  );
}

function verdictText(verdict: RsqVerdict | null): string {
  return verdict ? RSQ_VERDICT_LABEL[verdict] : "未判定";
}

function fmtScore(v: number | null | undefined): string {
  return typeof v === "number" && Number.isFinite(v) ? String(v) : "—";
}

/** 单次报告正文 */
function ReportBody({ record }: { record: RSQReportData }) {
  const [showAllDims, setShowAllDims] = useState(false);
  const v = record.validity;
  const dimTotal = RSQ_DIM_GROUPS.reduce((n, g) => n + g.keys.length, 0);
  const answerCount = scoredAnswerCount(record.raw);

  return (
    <div className="space-y-4">
      {/* 头部：时间 + 效度徽章 */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border/60 bg-accent/20 px-3 py-2">
        <span className="text-[11px] tabular-nums text-muted-foreground">{formatAnsweredAt(record.answeredAt)}</span>
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-[10px] font-medium",
            v.verdict === "reliable" && "bg-primary/15 text-primary",
            v.verdict === "questionable" && "bg-amber-500/15 text-amber-500",
            v.verdict === "likely-deceptive" && "bg-destructive/15 text-destructive",
            v.verdict == null && "bg-muted text-muted-foreground",
          )}
        >
          {verdictText(v.verdict)}
        </span>
        <span className="text-[10px] text-muted-foreground/60">题库 {record.itemsVersion}</span>
        {record.batteryLevel ? (
          <span className="text-[10px] text-muted-foreground/60">
            电池 {record.batteryLevel} 级{record.model ? " · " + record.model : ""}
          </span>
        ) : null}
        {v.flags.length ? (
          <span className="text-[10px] text-amber-500/80">
            {v.flags.map((f) => RSQ_FLAG_LABELS[f] ?? f).join(" · ")}
          </span>
        ) : null}
      </div>

      {/* 自评（第 120 题）*/}
      {record.selfSummary ? (
        <div className="rounded-lg border border-border/50 px-3 py-2.5">
          <div className="mb-1 text-[10px] font-medium text-muted-foreground/70">
            第 {RSQ_SELF_SUMMARY_NO} 题 · 角色自评
          </div>
          <p
            className="whitespace-pre-wrap text-[14px] leading-[1.8] text-foreground/90"
            style={{ fontFamily: '"KaiTi","Kaiti SC","STKaiti","Noto Serif SC",serif' }}
          >
            <span className="pointer-events-none select-none text-[20px] text-primary/35">“</span>
            {record.selfSummary}
            <span className="pointer-events-none select-none text-[20px] text-primary/35">”</span>
          </p>
        </div>
      ) : null}

      {/* 45 维 */}
      <div>
        <button
          type="button"
          className="mb-2 flex w-full items-center gap-1 text-[11px] font-medium text-foreground"
          onClick={() => setShowAllDims((x) => !x)}
          aria-expanded={showAllDims}
        >
          {showAllDims ? "▾" : "▸"} 维度明细（{dimTotal} 维）
        </button>
        {showAllDims ? (
          <div className="space-y-3">
            {RSQ_DIM_GROUPS.map((g) => (
              <div key={g.title}>
                <div className="mb-1 text-[10px] font-medium text-muted-foreground/70">{g.title}</div>
                <div className="grid grid-cols-2 gap-x-4 sm:grid-cols-3">
                  {g.keys.map(([k, label]) => (
                    <div key={k} className="flex items-baseline justify-between border-b border-border/20 py-0.5">
                      <span className="text-[10px] text-muted-foreground/80">{label}</span>
                      <span className="text-[10px] tabular-nums text-foreground/90">{fmtScore(record.dims[k])}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
            <div className="mt-2 rounded border border-border/40 p-2">
              <div className="mb-1 text-[10px] font-medium text-muted-foreground/70">派生指标</div>
              <div className="grid grid-cols-2 gap-x-4 sm:grid-cols-3">
                {Object.entries(record.derived).map(([k, val]) => (
                  <div key={k} className="flex items-baseline justify-between border-b border-border/20 py-0.5">
                    <span className="text-[10px] text-muted-foreground/80">{RSQ_DERIVED_LABELS[k] ?? k}</span>
                    <span className="text-[10px] tabular-nums text-foreground/90">{fmtScore(val)}</span>
                  </div>
                ))}
                {Object.keys(record.derived).length === 0 ? (
                  <span className="text-[10px] text-muted-foreground/60">旧记录没有派生指标</span>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}
      </div>

      {/* 效度 */}
      <div>
        <div className="mb-1 flex items-baseline gap-2">
          <span className="text-[11px] font-medium text-foreground">效度明细（六层）</span>
          <span className="text-[9px] text-muted-foreground/50">
            各项独立可查；综合判定为启发式，仅作筛选参考
          </span>
        </div>
        <div className="rounded-lg border border-border/50 px-3 py-1">
          <ValidityRow label="正反题一致性" value={v.consistency.toFixed(2)} hint="越高越可信" />
          <ValidityRow label="社会赞许性" value={v.socialDesirability.toFixed(2)} hint="越高越可疑" />
          <ValidityRow label="谎言论" value={v.lieScale.toFixed(2)} />
          <ValidityRow label="暗黑三人格" value={String(Math.round(v.darkTriad))} hint="0–100" />
          <ValidityRow label="跨源偏离" value={v.behavioralGap.toFixed(2)} hint="与 thought 的偏离" />
          <ValidityRow label="作答体验一致性" value={v.experienceConsistency.toFixed(2)} />
          <ValidityRow label="综合效度" value={v.overall.toFixed(2)} hint="启发式" />
        </div>
      </div>

      {/* 原始答卷（119 道计分题；第 120 题自评单独展示）*/}
      <div>
        <div className="mb-1 text-[11px] font-medium text-foreground">
          原始答卷（{answerCount}/{RSQ_SCORED_ITEM_COUNT} 题）
        </div>
        <div className="max-h-40 overflow-y-auto rounded-lg border border-border/50 p-2">
          <div className="grid grid-cols-6 gap-x-2 gap-y-1 sm:grid-cols-8">
            {Object.entries(record.raw)
              .filter(([no]) => Number(no) >= 1 && Number(no) <= RSQ_SCORED_ITEM_COUNT)
              .sort((a, b) => Number(a[0]) - Number(b[0]))
              .map(([no, score]) => (
                <span key={no} className="flex items-baseline gap-0 text-[10px] tabular-nums">
                  <span className="w-[18px] text-right text-muted-foreground/45">{no}</span>
                  <span className="mx-0.5 text-muted-foreground/25">·</span>
                  <span className="font-medium text-foreground/85">{score}</span>
                </span>
              ))}
          </div>
          {answerCount === 0 ? (
            <p className="text-[10px] text-muted-foreground/60">该记录没有可复原的原始答案（旧数据）</p>
          ) : null}
          {record.selfSummary ? (
            <p className="mt-2 border-t border-border/30 pt-1.5 text-[10px] text-muted-foreground/70">
              第 {RSQ_SELF_SUMMARY_NO} 题（自评）：{record.selfSummary}
            </p>
          ) : null}
        </div>
      </div>

      {/* 作答反馈 */}
      {record.feedback ? (
        <div>
          <div className="mb-1 text-[11px] font-medium text-foreground">角色自己的反馈</div>
          <div className="space-y-2 rounded-lg border border-border/50 p-3">
            <div className="flex flex-wrap gap-3 text-[10px] text-muted-foreground">
              <span>填完感受 {record.feedback.affect}/7</span>
              <span>再填意愿 {record.feedback.willingness}/7</span>
              <span>认为问到点子上 {record.feedback.perceivedDepth}/7</span>
            </div>
            {record.feedback.hardestItems.length ? (
              <div>
                <div className="text-[10px] font-medium text-muted-foreground/70">最难回答的题</div>
                {record.feedback.hardestItems.map((h, i) => (
                  <div key={i} className="text-[10px] text-foreground/80">
                    {h.itemNo != null ? `第 ${h.itemNo} 题：` : ""}
                    {h.reason}
                    {h.tag ? <span className="ml-1 text-[9px] text-muted-foreground/50">[{h.tag}]</span> : null}
                  </div>
                ))}
              </div>
            ) : null}
            {record.feedback.missingDimensions.length ? (
              <div>
                <div className="text-[10px] font-medium text-muted-foreground/70">
                  它认为问卷漏掉的方面
                </div>
                {record.feedback.missingDimensions.map((m, i) => (
                  <div key={i} className="text-[10px] text-foreground/80">
                    · {m.suggestion}
                    {m.possibleDimension ? (
                      <span className="ml-1 text-[9px] text-muted-foreground/50">→ {m.possibleDimension}</span>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function RSQReportDialog(props: RSQReportDialogProps) {
  const { open, onOpenChange, fromName, toName, records, initialId, className } = props;
  // 弹窗由上层在「打开时才挂载」，所以内部状态天然每次打开重置（无需 effect setState）
  const [view, setView] = useState<"report" | "history">("report");
  const [activeId, setActiveId] = useState<number | null>(initialId ?? null);

  const sorted = useMemo(
    () => [...records].sort((a, b) => +new Date(b.answeredAt) - +new Date(a.answeredAt)),
    [records],
  );

  const active = useMemo(
    () => sorted.find((r) => r.id === activeId) ?? sorted[0] ?? null,
    [sorted, activeId],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn("max-w-2xl", className)}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            {view === "history" ? (
              <>
                <button
                  type="button"
                  onClick={() => setView("report")}
                  className="rounded p-0.5 hover:bg-accent"
                  aria-label="返回报告"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                历史测评结果
                <span className="text-xs font-normal text-muted-foreground">（{sorted.length} 次）</span>
              </>
            ) : (
              <>
                <ClipboardList className="h-4 w-4" />
                关系测评报告 · {fromName} → {toName}
              </>
            )}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {view === "history"
              ? "点任一张卡片，查看该次测评的完整报告。"
              : "45 维得分 · 效度检验 · 原始答卷（119 题 + 第 120 题自评）· 角色反馈。数据可追溯到每一道题。"}
          </DialogDescription>
        </DialogHeader>

        {view === "history" ? (
          <div className="max-h-[62vh] space-y-3 overflow-y-auto pr-1">
            {sorted.map((r) => (
              <RelationCard
                key={r.id}
                compact
                fromName={fromName}
                toName={toName}
                selfSummary={r.selfSummary}
                radar={r.radar as RadarDatum[]}
                answeredAt={r.answeredAt ? new Date(r.answeredAt) : null}
                verdict={r.validity.verdict}
                validityOverall={r.validity.overall}
                onOpenAnswers={() => { setActiveId(r.id); setView("report"); }}
              />
            ))}
          </div>
        ) : active ? (
          <div className="max-h-[62vh] overflow-y-auto pr-1">
            <ReportBody record={active} />
          </div>
        ) : (
          <p className="py-8 text-center text-sm text-muted-foreground">暂无测评数据</p>
        )}

        {view === "report" && sorted.length > 0 ? (
          <div className="flex items-center justify-between border-t border-border pt-3">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setView("history")}
              disabled={sorted.length <= 1}
            >
              <History className="mr-1 h-3.5 w-3.5" />
              查看历史测评结果（{sorted.length}）
            </Button>
            <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>
              关闭
            </Button>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
