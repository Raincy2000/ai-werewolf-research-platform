/**
 * 现实层（L1）时间线
 *
 * 展示某个视角下「我与他经历过的事」：
 *   每个节点 = 一件事 + 一段复合感受（当时/中途/现在都写在同一段里）
 *
 * 设计原则：
 *  · 单视角 —— 这里只有「这个人记得的」，不显示对方的版本
 *  · 双来源 —— 原世界（补完/手录）与山谷（对局变动）同框，各自带来源徽标
 *  · 可滚动 —— 关系有多厚就有多长
 *  · 可编辑 —— 用户可改、可增、可软删
 */
import { useState } from "react";
import { GripVertical, Pencil, Plus, Trash2, ShieldCheck, ShieldAlert, ShieldQuestion, UserPen, Swords } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** 时间线来源：原世界 / 山谷 */
export type TimelineSource = "canon" | "valley";

export interface CanonItem {
  id: number;
  seq: number;
  /** 手动排序位（拖动后写入；null=按时间线时代排序） */
  sortOrder?: number | null;
  era: string;
  /** 当时年龄 */
  age: number | null;
  /** 发生地点 */
  place: string | null;
  /** 时间依据（原作明载 / 推定链）*/
  eraBasis?: string | null;
  eventText: string;
  feeling: string;
  impact: string | null;
  certainty: string;
  verification: string;
  origin: string;
  sourceCount?: number;
  /** 来源：原世界(canon) / 山谷(vale) */
  source?: TimelineSource;
}

export interface CanonTimelineProps {
  items: CanonItem[];
  /** 被评价者名字（用于空态提示）*/
  toName?: string;
  onEdit?: (item: CanonItem) => void;
  onDelete?: (id: number) => void;
  onAdd?: () => void;
  /** 是否显示空态（面板自带视图切换时可以关掉外层空态）*/
  hideEmpty?: boolean;
  /** 允许拖动排序（仅原世界事件；山谷事件只读不参与） */
  reorderable?: boolean;
  /** 拖动完成回调：按新顺序返回原世界事件 id 列表 */
  onReorder?: (orderedIds: number[]) => void | Promise<void>;
  /** 排序请求进行中（禁用拖动） */
  reordering?: boolean;
  className?: string;
}

const SERIF_CN = '"KaiTi", "Kaiti SC", "STKaiti", "Noto Serif SC", "Songti SC", "SimSun", serif';

/** 验证状态徽标 */
function VerifyBadge({ item }: { item: CanonItem }) {
  if (item.source === "valley") {
    return (
      <span className="inline-flex items-center gap-0.5 text-[9px] text-muted-foreground/60">
        <Swords className="h-2.5 w-2.5" /> 山谷
      </span>
    );
  }
  if (item.verification === "manual" || item.origin === "manual") {
    return (
      <span className="inline-flex items-center gap-0.5 text-[9px] text-muted-foreground/60">
        <UserPen className="h-2.5 w-2.5" /> 手录
      </span>
    );
  }
  if (item.verification === "confirmed") {
    return (
      <span className="inline-flex items-center gap-0.5 text-[9px] text-emerald-600/80 dark:text-emerald-500/80">
        <ShieldCheck className="h-2.5 w-2.5" /> 已核
        {item.sourceCount ? <span className="text-muted-foreground/50">×{item.sourceCount}</span> : null}
      </span>
    );
  }
  if (item.verification === "cross-checked") {
    return (
      <span className="inline-flex items-center gap-0.5 text-[9px] text-emerald-600/70 dark:text-emerald-500/70">
        <ShieldCheck className="h-2.5 w-2.5" /> 交叉核实
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-0.5 text-[9px] text-amber-500/70">
      <ShieldQuestion className="h-2.5 w-2.5" /> 待核
    </span>
  );
}

export function CanonTimeline(props: CanonTimelineProps) {
  const { items, toName, onEdit, onDelete, onAdd, hideEmpty, reorderable, onReorder, reordering, className } = props;
  // ★ hover 键 = source + id：原世界与山谷的 id 各自自增，只用 id 会在两个来源间串行点亮（P2-22）
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  /** 原世界事件拖动排序（2026-10-22） */
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);
  const canonItems = items.filter((x) => x.source !== "valley");
  const canDrag = reorderable === true && !!onReorder && canonItems.length > 1 && !reordering;

  const dropOn = async (targetKey: string) => {
    if (!canDrag || !dragKey || dragKey === targetKey) {
      setDragKey(null);
      setOverKey(null);
      return;
    }
    const keys = canonItems.map((x) => x.source + "-" + x.id);
    const from = keys.indexOf(dragKey);
    const to = keys.indexOf(targetKey);
    if (from < 0 || to < 0) {
      setDragKey(null);
      setOverKey(null);
      return;
    }
    keys.splice(to, 0, keys.splice(from, 1)[0]!);
    const orderedIds = keys
      .map((k) => canonItems.find((x) => x.source + "-" + x.id === k)?.id)
      .filter((id): id is number => typeof id === "number");
    setDragKey(null);
    setOverKey(null);
    await onReorder!(orderedIds);
  };

  if (items.length === 0 && !hideEmpty) {
    return (
      <div className={cn("flex flex-col items-center justify-center gap-2 py-10 text-center", className)}>
        <ShieldAlert className="h-5 w-5 text-muted-foreground/40" />
        <p className="text-[11px] text-muted-foreground/60">
          还没有和{toName ? "「" + toName + "」" : "这个人"}的记忆记录
        </p>
        {onAdd ? (
          <Button size="sm" variant="outline" onClick={onAdd} className="mt-1 h-7 text-[11px]">
            <Plus className="mr-1 h-3 w-3" /> 手动补充一条
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <div className={cn("relative", className)}>
      <ol className="relative space-y-4 pl-5">
        <span aria-hidden className="absolute left-[5px] top-1 bottom-1 w-px bg-border/70" />

        {items.map((item) => {
          const key = item.source + "-" + item.id;
          const active = hoverKey === key;
          const isValley = item.source === "valley";
          return (
            <li
              key={key}
              draggable={canDrag && !isValley}
              onDragStart={(e) => {
                if (!canDrag || isValley) return;
                setDragKey(key);
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", key);
              }}
              onDragOver={(e) => {
                if (!canDrag || isValley) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                if (overKey !== key) setOverKey(key);
              }}
              onDragLeave={() => { if (overKey === key) setOverKey(null); }}
              onDrop={(e) => { e.preventDefault(); void dropOn(key); }}
              onDragEnd={() => { setDragKey(null); setOverKey(null); }}
              className={cn(
                "group relative",
                dragKey === key && "opacity-45",
                overKey === key && dragKey !== key && "before:absolute before:-top-2 before:left-0 before:right-0 before:h-0.5 before:bg-primary",
              )}
              onMouseEnter={() => setHoverKey(key)}
              onMouseLeave={() => setHoverKey(null)}
              onFocus={() => setHoverKey(key)}
              onBlur={() => setHoverKey(null)}
            >
              <span
                aria-hidden
                className={cn(
                  "absolute -left-5 top-1.5 h-2 w-2 rounded-full border transition-colors",
                  active ? "border-primary bg-primary" : isValley ? "border-muted-foreground/40 bg-background" : "border-border bg-background",
                )}
              />

              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="text-[10px] tabular-nums text-muted-foreground/70">
                  {item.era}
                  {item.age != null ? " · " + item.age + "岁" : ""}
                </span>
                {item.place ? (
                  <span className="rounded-sm bg-accent/40 px-1 py-px text-[9px] text-muted-foreground/80">
                    {item.place}
                  </span>
                ) : null}
                {item.eraBasis && /推定|推断|推测|应为|据此/.test(item.eraBasis) ? (
                  <span
                    className="cursor-help rounded-sm bg-amber-500/15 px-1 py-px text-[9px] text-amber-600 dark:text-amber-400"
                    title={item.eraBasis}
                  >
                    推定
                  </span>
                ) : null}
                <VerifyBadge item={item} />
                {onEdit || onDelete || (canDrag && !isValley) ? (
                  <span
                    className={cn(
                      "ml-auto flex items-center gap-0.5 transition-opacity focus-within:opacity-100 group-hover:opacity-100",
                      active ? "opacity-100" : "opacity-0",
                    )}
                  >
                    {canDrag && !isValley ? (
                      <span
                        role="button"
                        tabIndex={0}
                        aria-label="拖动调整事件顺序"
                        title="拖动调整事件顺序"
                        className="inline-flex h-5 w-4 cursor-grab items-center justify-center rounded text-muted-foreground/70 hover:text-foreground active:cursor-grabbing"
                        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") e.preventDefault(); }}
                      >
                        <GripVertical className="h-3 w-3" />
                      </span>
                    ) : null}
                    {onEdit ? (
                      <Button size="icon" variant="ghost" className="h-5 w-5" onClick={() => onEdit(item)} aria-label="编辑">
                        <Pencil className="h-2.5 w-2.5" />
                      </Button>
                    ) : null}
                    {onDelete ? (
                      <Button size="icon" variant="ghost" className="h-5 w-5" onClick={() => onDelete(item.id)} aria-label="删除">
                        <Trash2 className="h-2.5 w-2.5" />
                      </Button>
                    ) : null}
                  </span>
                ) : null}
              </div>

              <p className="mt-1 text-[13px] leading-relaxed text-foreground/90">{item.eventText}</p>

              <p
                className="mt-1 whitespace-pre-wrap text-[12px] leading-[1.75] text-foreground/65"
                style={{ fontFamily: SERIF_CN }}
              >
                {item.feeling}
              </p>

              {item.impact ? (
                <p className="mt-1 text-[10px] text-muted-foreground/60">
                  <span className="text-muted-foreground/40">→</span> {item.impact}
                </p>
              ) : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
