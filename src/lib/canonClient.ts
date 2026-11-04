/**
 * 现实层（manual canon）手录表单纯逻辑：默认值、校验、提交值归一。
 *
 * 独立于 React 组件，便于单测（CanonEventDialog 只负责渲染与调用）。
 * 后端 zod 已补 age/place（P2-3）：空串 = 未填 → null；年龄必须是 0–200 的整数/数字。
 */

/** 表单值（年龄保持字符串，提交时再解析） */
export interface CanonEventFormValue {
  era: string
  age: string
  place: string
  eventText: string
  feeling: string
  impact: string
}

/** 提交值（新增/编辑 mutation 的入参形态） */
export interface CanonEventSubmitValue {
  era: string
  age: number | null
  place: string | null
  eventText: string
  feeling: string
  impact: string | null
}

export function emptyCanonForm(initial?: Partial<CanonEventFormValue> | null): CanonEventFormValue {
  return {
    era: initial?.era ?? '',
    age: initial?.age ?? '',
    place: initial?.place ?? '',
    eventText: initial?.eventText ?? '',
    feeling: initial?.feeling ?? '',
    impact: initial?.impact ?? '',
  }
}

/** 校验原因（给 UI 精确提示）；通过返回 null */
export function canonFormError(form: CanonEventFormValue): string | null {
  if (!form.era.trim()) return '请填写时间（如「2006年夏」）'
  if (!form.eventText.trim()) return '请填写事件经过'
  if (!form.feeling.trim()) return '请填写当时的感受（可写复合感受）'
  const ageRaw = form.age.trim()
  if (ageRaw !== '') {
    const age = Number(ageRaw)
    // 后端 zod：age 必须为 0–200 的整数（不清楚可留空）
    if (!Number.isFinite(age) || !Number.isInteger(age) || age < 0 || age > 200) {
      return '年龄必须是 0–200 之间的整数（不清楚可留空）'
    }
  }
  return null
}

/** 表单 → 提交值：空串按「未填」处理；非法返回 null（调用方先用 canonFormError 提示） */
export function toCanonSubmitValue(form: CanonEventFormValue): CanonEventSubmitValue | null {
  if (canonFormError(form) != null) return null
  const ageRaw = form.age.trim()
  const age = ageRaw === '' ? null : Number(ageRaw)
  if (age != null && (!Number.isFinite(age) || !Number.isInteger(age) || age < 0 || age > 200)) return null
  const place = form.place.trim()
  const impact = form.impact.trim()
  return {
    era: form.era.trim(),
    age,
    place: place ? place : null,
    eventText: form.eventText.trim(),
    feeling: form.feeling.trim(),
    impact: impact ? impact : null,
  }
}
