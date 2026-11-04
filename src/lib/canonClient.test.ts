/**
 * manual canon 手录表单纯逻辑单测（审计 P1-4 / P2-3）
 */
import { describe, expect, it } from 'vitest'
import {
  canonFormError,
  emptyCanonForm,
  toCanonSubmitValue,
  type CanonEventFormValue,
} from './canonClient'

const form = (patch: Partial<CanonEventFormValue> = {}): CanonEventFormValue => ({
  era: '2006年夏',
  age: '15',
  place: '希干希纳区',
  eventText: '巨人破墙，三笠把艾伦拉出废墟。',
  feeling: '害怕，但也有一种奇怪的安心。',
  impact: '从此把她当成唯一的依靠。',
  ...patch,
})

describe('canon 手录表单纯逻辑', () => {
  it('emptyCanonForm 填默认空串（可带入编辑初值）', () => {
    expect(emptyCanonForm()).toEqual({ era: '', age: '', place: '', eventText: '', feeling: '', impact: '' })
    const edit = emptyCanonForm({ era: '850年', age: '15', place: '' })
    expect(edit.era).toBe('850年')
    expect(edit.age).toBe('15')
  })

  it('必填校验：时间 / 事件 / 感受缺一不可', () => {
    expect(canonFormError(form())).toBeNull()
    expect(canonFormError(form({ era: '  ' }))).toContain('时间')
    expect(canonFormError(form({ eventText: '' }))).toContain('事件经过')
    expect(canonFormError(form({ feeling: ' ' }))).toContain('感受')
  })

  it('年龄：可留空；非法值/小数拒绝；0–200 整数合法', () => {
    expect(canonFormError(form({ age: '' }))).toBeNull()
    expect(canonFormError(form({ age: 'abc' }))).toContain('0–200')
    expect(canonFormError(form({ age: '-1' }))).toContain('0–200')
    expect(canonFormError(form({ age: '201' }))).toContain('0–200')
    expect(canonFormError(form({ age: '15.5' }))).toContain('整数')
    expect(canonFormError(form({ age: '0' }))).toBeNull()
    expect(canonFormError(form({ age: '200' }))).toBeNull()
  })

  it('toCanonSubmitValue：trim、空串→null、年龄数字', () => {
    const v = toCanonSubmitValue(form({ era: '  850年  ', place: '  ', impact: '' }))
    expect(v).toEqual({
      era: '850年',
      age: 15,
      place: null,
      eventText: '巨人破墙，三笠把艾伦拉出废墟。',
      feeling: '害怕，但也有一种奇怪的安心。',
      impact: null,
    })
  })

  it('toCanonSubmitValue：年龄留空 → null；校验不通过 → null', () => {
    expect(toCanonSubmitValue(form({ age: ' ' }))!.age).toBeNull()
    expect(toCanonSubmitValue(form({ era: '' }))).toBeNull()
    expect(toCanonSubmitValue(form({ age: 'xx' }))).toBeNull()
  })
})
