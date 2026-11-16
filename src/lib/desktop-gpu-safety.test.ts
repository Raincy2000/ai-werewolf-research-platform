import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../../desktop/main.mjs', import.meta.url), 'utf8')

describe('桌面端 GPU 挂起防护', () => {
  it('在 Electron 就绪前禁用硬件加速，并记录渲染进程异常', () => {
    const disableAt = source.indexOf('app.disableHardwareAcceleration()')
    const readyAt = source.indexOf('app.whenReady()')
    expect(disableAt).toBeGreaterThanOrEqual(0)
    expect(readyAt).toBeGreaterThan(disableAt)
    expect(source).toContain("app.commandLine.appendSwitch('disable-gpu')")
    expect(source).toContain('render-process-gone')
    expect(source).toContain("win.on('unresponsive'")
  })
})
