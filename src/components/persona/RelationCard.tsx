/**
 * 关系卡片（RSQ 结果）
 *
 * 布局：
 *   左 —— 八维雷达（可点击放大，不遮挡右侧；鼠标离开复位）
 *   右 —— 角色自评语（楷体、支持分行、装饰引号、落款）
 *   底 —— 关键维度速览
 *
 * 交互：
 *   · 点雷达图 → 放大，再点或移开复位
 *   · 点卡片 → 打开详情（39 维 / 历史答卷 / 效度）
 *   · 点 📋 → 打开原始答卷
 */
import { useState } from "react";
import { BookOpen, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { RelationRadar, type RadarDatum } from "./RelationRadar";

export interface RelationCardProps {
  fromName: string;
  toName: string;
  /** 第 120 题：角色自评（可含换行，<=36 字）*/
  selfSummary: string | null;
  radar: RadarDatum[];
  /** 上一次答卷的雷达（叠加虚线对照）*/
  compareRadar?: RadarDatum[];
  answeredAt: Date | null;
  /** 精简模式：用于「历史测评结果」列表（点击整卡 = 看该次报告）*/
  compact?: boolean;
  verdict: "reliable" | "questionable" | "likely-deceptive" | null;
  /** @deprecated 综合效度分是启发式，仅报告内展示，卡片不再使用 */
  validityOverall?: number | null;
  /** 原型参考（弱化显示，非权威分类）*/
  archetypeHint?: string | null;
  onOpenDetail?: () => void;
  onOpenAnswers?: () => void;
  className?: string;
}

/** 中文艺术字体栈：楷体优先（手写感），退化到宋体衬线 */
const SERIF_CN = '"KaiTi", "Kaiti SC", "STKaiti", "Noto Serif SC", "Songti SC", "SimSun", serif';

/**
 * 评语字号自适应：按字数分档，让 36 字内都能"基本占满"右侧空间。
 * 字数越少字越大（视觉冲击），字数越多适当缩小（保证不溢出不缩成蚂蚁）。
 */
function summaryFontSize(text: string, compact: boolean): number {
  // 关键：按**最长一行**反推字号，而不是总字数。
  // 否则放大后原换行会被撑破，出现「人，」这种孤字成行。
  // 右侧可用宽约 330px（已扣除首尾引号的额外占位）；中文字宽 ≈ 字号。
  const lines = text.split("\n");
  const maxLen = Math.max(1, ...lines.map((l) => l.length));
  // 评语区真实可用宽 ≈ 360px（卡片 560 − padding 24 − 雷达 150 − gap 12 − 右内边距 8）
  // 再扣首尾引号占位 ≈ 2 字，故有效字数 = maxLen + 2
  // 实测：独立卡片宽 364px；嵌入详情面板后约 330px。
  // 用 300 作安全基数，保证 12 字行在两种容器下都不折行。
  const ideal = 300 / (maxLen + 2);
  const size = Math.min(28, Math.max(16, ideal));
  return compact
    ? Math.round(size * 0.72 * 10) / 10
    : Math.round(size * 10) / 10;
}

const VERDICT_STYLE: Record<string, { label: string; cls: string }> = {
  reliable: { label: "可信", cls: "text-primary" },
  questionable: { label: "存疑", cls: "text-amber-500" },
  "likely-deceptive": { label: "疑似伪装", cls: "text-destructive" },
};

function fmtDate(d: Date | null): string {
  if (!d) return "—";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function RelationCard(props: RelationCardProps) {
  const {
    fromName,
    toName,
    selfSummary,
    radar,
    compareRadar,
    answeredAt,
    compact = false,
    verdict,
    archetypeHint,
    onOpenDetail,
    onOpenAnswers,
    className,
  } = props;

  const [zoomRadar, setZoomRadar] = useState(false);
  const verdictStyle = verdict ? VERDICT_STYLE[verdict] : null;

  return (
    <div
      className={cn(
        "group relative mx-auto w-full max-w-[560px] overflow-hidden rounded-xl border border-border bg-gradient-to-br from-card to-card/40",
        "transition-colors hover:border-border/80",
        compact && "cursor-pointer hover:bg-accent/20",
        className,
      )}
      onClick={compact ? onOpenAnswers : undefined}
      role={compact ? "button" : undefined}
      tabIndex={compact ? 0 : undefined}
      onKeyDown={compact ? (e) => { if (e.key === "Enter" || e.key === " ") onOpenAnswers?.(); } : undefined}
    >
      {/* ===== 标题行 ===== */}
      <div className="flex items-center gap-2 border-b border-border/50 px-4 py-2.5">
        <span className="text-[13px] font-medium tracking-wide text-foreground">{fromName}</span>
        <ChevronRight className="h-3 w-3 text-muted-foreground/60" aria-hidden />
        <span className="text-[13px] font-medium tracking-wide text-foreground">{toName}</span>
        {compact ? (
          <span className="ml-1 tabular-nums text-[10px] text-muted-foreground/60">{fmtDate(answeredAt)}</span>
        ) : archetypeHint ? (
          <span className="ml-1 text-[10px] text-muted-foreground/50">{archetypeHint}</span>
        ) : null}
        <div className="ml-auto flex items-center gap-1">
          {!compact && onOpenAnswers ? (
            <Button
              size="icon"
              variant="ghost"
              className="h-6 w-6 opacity-40 transition-opacity group-hover:opacity-90"
              onClick={(e) => { e.stopPropagation(); onOpenAnswers(); }}
              aria-label="查看原始答卷"
              title="查看原始答卷与历史"
            >
              <BookOpen className="h-3.5 w-3.5" />
            </Button>
          ) : null}
        </div>
      </div>

      {/* ===== 主体：左雷达 / 右评语 ===== */}
      <div className="flex items-stretch gap-3 px-3 py-3">
        {/* --- 雷达（点击放大，放大后仍限制在左栏内，不会压到右侧文字）--- */}
        <div
          className={cn(
            "relative flex shrink-0 items-center justify-center overflow-hidden",
            compact ? "w-[120px]" : "w-[150px]",
          )}
          onMouseLeave={() => setZoomRadar(false)}
        >
          <button
            type="button"
            className="cursor-zoom-in outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 rounded-full"
            onClick={(e) => { e.stopPropagation(); setZoomRadar((v) => !v); }}
            aria-label={zoomRadar ? "缩小雷达图" : "放大雷达图"}
            aria-pressed={zoomRadar}
          >
            <div
              className={cn(
                "origin-center transition-transform duration-300 ease-out",
                zoomRadar ? "scale-[1.16]" : "scale-100",
              )}
              style={{ transformOrigin: "center center" }}
            >
              <RelationRadar
                data={radar}
                compare={compareRadar}
                size={compact ? 104 : 128}
                showLabels
                labelSize={compact ? 8 : 9}
              />
            </div>
          </button>
        </div>

        {/* --- 评语（自适应字号，占据右侧主要空间）--- */}
        <div className="flex min-w-0 flex-1 flex-col py-1">
          <div className="relative pr-2">
            {selfSummary ? (
              <p
                className={cn(
                  "flex-1 whitespace-pre-wrap tracking-wide text-foreground/90",
                  compact ? "min-h-[56px]" : "min-h-[96px]",
                )}
                style={{
                  fontFamily: SERIF_CN,
                  fontSize: summaryFontSize(selfSummary, compact),
                  lineHeight: 1.72,
                }}
              >
                {/* 简体中文标准引号（GB/T 15834）：首尾内联包裹，随文字流动不脱位 */}
                <span
                  aria-hidden
                  className="pointer-events-none select-none text-primary/35"
                  style={{ fontFamily: SERIF_CN, fontSize: "1.15em" }}
                >
                  “
                </span>
                {selfSummary}
                <span
                  aria-hidden
                  className="pointer-events-none select-none text-primary/35"
                  style={{ fontFamily: SERIF_CN, fontSize: "1.15em" }}
                >
                  ”
                </span>
              </p>
            ) : (
              <p className="text-xs italic text-muted-foreground/60">（尚未填写自评）</p>
            )}
          </div>

          {/* 落款：固定在主体区底部、分隔线上方 */}
          <div className="mt-auto flex items-center justify-end gap-1.5 pt-3 text-[10px] text-muted-foreground/70">
            <span className="h-px w-5 bg-border/70" />
            {!compact ? <span className="tabular-nums">{fmtDate(answeredAt)}</span> : null}
            {verdictStyle ? (
              <span className={cn("font-medium", verdictStyle.cls)}>{verdictStyle.label}</span>
            ) : null}
          </div>
        </div>
      </div>

      {/* ===== 底部：唯一入口 ===== */}
      <div className="border-t border-border/50 px-4 py-2">
        <button
          type="button"
          onClick={compact ? onOpenAnswers : onOpenDetail}
          className="w-full text-left text-[11px] text-muted-foreground/70 transition-colors hover:text-foreground"
        >
          {compact ? "查看该次测评报告 →" : "查看关系测评详情 →"}
        </button>
      </div>
    </div>
  );
}
