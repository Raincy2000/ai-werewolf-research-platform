import { Link, NavLink } from 'react-router'
import AccountMenu from '@/components/AccountMenu'
import { WolfBanLogo } from '@/components/icons/WolfBanLogo'
import { cn } from '@/lib/utils'

/**
 * 顶部 sticky 导航栏：左侧产品名，右侧导航链接。
 * 布局契约（react-dev.md）：sticky 处于文档流内，页面无需自行补偿高度。
 */
export default function Navbar() {
  return (
    <header className="sticky top-0 z-50 w-full border-b border-border bg-card">
      <div className="mx-auto flex h-14 max-w-[1600px] items-center justify-between gap-2 px-3 sm:px-8">
        <Link
          to="/"
          className="flex shrink-0 items-center gap-2.5 rounded-lg border-2 border-foreground px-2.5 py-1.5 text-foreground"
        >
          <WolfBanLogo className="h-6 w-6 shrink-0 text-foreground" aria-hidden />
          {/* 移动端只留图标：完整名称在极窄屏会折行挤占导航链接 */}
          <span className="hidden whitespace-nowrap font-brand text-base leading-none tracking-tight sm:inline">
            AI模拟狼人杀研究平台
          </span>
        </Link>
        <nav className="flex shrink-0 items-center gap-1 text-sm">
          {/* 账户入口：未登录显示「登录 / 注册」，已登录显示头像菜单 */}
          <AccountMenu />
          <NavLink
            to="/"
            end
            className={({ isActive }) =>
              cn(
                'shrink-0 whitespace-nowrap rounded-md px-2 py-1.5 transition-colors sm:px-3',
                isActive
                  ? 'bg-secondary font-medium text-foreground'
                  : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
              )
            }
          >
            大厅
          </NavLink>
          <NavLink
            to="/history"
            className={({ isActive }) =>
              cn(
                'shrink-0 whitespace-nowrap rounded-md px-2 py-1.5 transition-colors sm:px-3',
                isActive
                  ? 'bg-secondary font-medium text-foreground'
                  : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
              )
            }
          >
            对局历史
          </NavLink>
          <NavLink
            to="/library"
            className={({ isActive }) =>
              cn(
                'shrink-0 whitespace-nowrap rounded-md px-2 py-1.5 transition-colors sm:px-3',
                isActive
                  ? 'bg-secondary font-medium text-foreground'
                  : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
              )
            }
          >
            图书馆
          </NavLink>
          <NavLink
            to="/guide"
            className={({ isActive }) =>
              cn(
                'shrink-0 whitespace-nowrap rounded-md px-2 py-1.5 transition-colors sm:px-3',
                isActive
                  ? 'bg-secondary font-medium text-foreground'
                  : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
              )
            }
          >
            经验指南
          </NavLink>
          <NavLink
            to="/personas"
            className={({ isActive }) =>
              cn(
                'shrink-0 whitespace-nowrap rounded-md px-2 py-1.5 transition-colors sm:px-3',
                isActive
                  ? 'bg-secondary font-medium text-foreground'
                  : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
              )
            }
          >
            人格研究库
          </NavLink>
        </nav>
      </div>
    </header>
  )
}
