import { cn } from '../../lib/utils'

interface AvatarProps extends React.HTMLAttributes<HTMLDivElement> {
  name?: string
  src?: string
  size?: 'sm' | 'md' | 'lg'
}

const sizeMap = {
  sm: 'h-7 w-7 text-[0.65rem]',
  md: 'h-9 w-9 text-xs',
  lg: 'h-11 w-11 text-sm',
}

function Avatar({ name, src, size = 'md', className, ...props }: AvatarProps) {
  const initials = name
    ? name
        .split(' ')
        .map(n => n[0])
        .join('')
        .toUpperCase()
        .slice(0, 2)
    : '?'

  return (
    <div
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full font-bold text-white select-none',
        'bg-gradient-to-br from-cyan-400/30 to-violet-500/30 border border-white/10',
        sizeMap[size],
        className
      )}
      {...props}
      aria-label={name || 'Avatar'}
    >
      {src ? (
        <img src={src} alt={name} className="h-full w-full rounded-full object-cover" />
      ) : (
        initials
      )}
    </div>
  )
}

export { Avatar }
