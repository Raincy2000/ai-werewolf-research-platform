/**
 * 关系雷达图（八轴）
 *
 * 为什么是 8 轴：雷达图可读上限约 6–8 轴；39 维全画会变成毛球。
 * 八轴取关系的五个面向：情感（喜爱/对抗）· 基础（信任/承诺）· 深度（亲密）
 *                     · 修复（原谅）· 结构与地位（公平/钦佩）
 *
 * 纯 SVG，零依赖；配色取自项目 design.md 的低饱和色板。
 */
import { useMemo } from "react";
import { cn } from "@/lib/utils";

export interface RadarDatum {
  axis: string;
  label: string;
  /** 0–100 */
  value: number;
}

export interface RelationRadarProps {
  data: RadarDatum[];
  /** 参考对照（如"上次答卷"），同轴叠加虚线多边形 */
  compare?: RadarDatum[];
  size?: number;
  className?: string;
  /** 是否显示轴标签 */
  showLabels?: boolean;
  /** 轴标签字号（默认 10）*/
  labelSize?: number;
}

const TAU = Math.PI * 2;

export function RelationRadar(props: RelationRadarProps) {
  const { data, compare, size = 220, className, showLabels = true, labelSize = 10 } = props;
  const cx = size / 2;
  const cy = size / 2;
  // 留出标签空间
  const r = size / 2 - (showLabels ? 26 : 8);

  const points = useMemo(() => {
    const n = data.length;
    return data.map((d, i) => {
      const angle = (i / n) * TAU - Math.PI / 2;
      const v = Math.max(0, Math.min(100, d.value)) / 100;
      return {
        ...d,
        angle,
        x: cx + Math.cos(angle) * r * v,
        y: cy + Math.sin(angle) * r * v,
        lx: cx + Math.cos(angle) * (r + (labelSize + 6)),
        ly: cy + Math.sin(angle) * (r + (labelSize + 6)),
        ax: cx + Math.cos(angle) * r,
        ay: cy + Math.sin(angle) * r,
      };
    });
  }, [data, cx, cy, r]);

  const comparePoints = useMemo(() => {
    if (!compare?.length) return null;
    const n = compare.length;
    const byAxis = new Map(data.map((d, i) => [d.axis, i]));
    return compare.map((d, i) => {
      const idx = byAxis.get(d.axis) ?? i;
      const angle = (idx / n) * TAU - Math.PI / 2;
      const v = Math.max(0, Math.min(100, d.value)) / 100;
      return { x: cx + Math.cos(angle) * r * v, y: cy + Math.sin(angle) * r * v };
    });
  }, [compare, data, cx, cy, r]);

  const poly = points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const comparePoly = comparePoints
    ? comparePoints.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")
    : null;

  // 三层网格（25% / 50% / 75%）
  const rings = [0.25, 0.5, 0.75];
  const ringPoly = (scale: number) =>
    data
      .map((_, i) => {
        const a = (i / data.length) * TAU - Math.PI / 2;
        return `${(cx + Math.cos(a) * r * scale).toFixed(1)},${(cy + Math.sin(a) * r * scale).toFixed(1)}`;
      })
      .join(" ");

  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      width={size}
      height={size}
      className={cn("overflow-visible", className)}
      role="img"
      aria-label="关系八维雷达图"
    >
      {/* 网格圈 */}
      {rings.map((s) => (
        <polygon
          key={s}
          points={ringPoly(s)}
          fill="none"
          stroke="currentColor"
          strokeOpacity={s === 0.5 ? 0.16 : 0.09}
          strokeWidth={1}
        />
      ))}
      {/* 轴线 */}
      {points.map((p) => (
        <line
          key={`ax-${p.axis}`}
          x1={cx}
          y1={cy}
          x2={p.ax}
          y2={p.ay}
          stroke="currentColor"
          strokeOpacity={0.12}
          strokeWidth={1}
        />
      ))}

      {/* 对照多边形（上次答卷）*/}
      {comparePoly ? (
        <polygon
          points={comparePoly}
          fill="none"
          stroke="currentColor"
          strokeOpacity={0.28}
          strokeWidth={1}
          strokeDasharray="4 3"
        />
      ) : null}

      {/* 数据多边形 */}
      <polygon
        points={poly}
        fill="hsl(var(--primary) / 0.16)"
        stroke="hsl(var(--primary) / 0.85)"
        strokeWidth={1.8}
        strokeLinejoin="round"
      />
      {/* 顶点 */}
      {points.map((p) => (
        <circle key={`pt-${p.axis}`} cx={p.x} cy={p.y} r={2.6} fill="hsl(var(--primary))" />
      ))}

      {/* 轴标签 */}
      {showLabels
        ? points.map((p) => (
            <text
              key={`lb-${p.axis}`}
              x={p.lx}
              y={p.ly}
              textAnchor="middle"
              dominantBaseline="middle"
              className="fill-current"
              style={{ fontSize: labelSize }}
              fillOpacity={0.68}
            >
              {p.label}
            </text>
          ))
        : null}
    </svg>
  );
}
