import { Link } from 'react-router'
import { Button } from '@/components/ui/button'

export default function NotFound() {
  return (
    <div className="mx-auto flex max-w-7xl flex-col items-center gap-4 px-4 py-24 text-center sm:px-6">
      <p className="font-mono text-4xl font-semibold text-muted-foreground">404</p>
      <p className="text-base text-foreground">页面不存在或已被移除</p>
      <Button asChild variant="outline">
        <Link to="/">返回大厅</Link>
      </Button>
    </div>
  )
}
