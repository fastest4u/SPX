import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { cn } from '../lib/utils'

const VEHICLE_TYPE_OPTIONS = ['6WH-6ล้อ[7.2m]', '4WH-4ล้อ', '4WJ-4ล้อจัมโบ้']

interface VehicleTypeMultiSelectProps {
  id: string
  value: string[]
  onChange: (value: string[]) => void
  disabled?: boolean
}

export function VehicleTypeMultiSelect({
  id,
  value,
  onChange,
  disabled = false,
}: VehicleTypeMultiSelectProps) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [open])
  const selectedVehicleTypes = new Set(value)

  const toggleValue = (option: string) => {
    onChange(
      selectedVehicleTypes.has(option)
        ? value.filter((item) => item !== option)
        : [...value, option],
    )
  }

  return (
    <div
      ref={root}
      className="relative"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.preventDefault()
          event.stopPropagation()
          setOpen(false)
          trigger.current?.focus()
        }
      }}
    >
      <button
        ref={trigger}
        id={id}
        type="button"
        disabled={disabled}
        aria-expanded={open && !disabled}
        aria-controls={`${id}-options`}
        onClick={() => setOpen((current) => !current)}
        className="flex min-h-11 w-full items-center justify-between gap-3 rounded-md border border-white/10 bg-white/5 px-3 py-2 text-left text-sm text-foreground ring-offset-background transition-colors hover:border-[color:var(--color-info-border)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span className={cn('line-clamp-2', value.length === 0 && 'text-muted-foreground')}>
          {value.length > 0 ? value.join(', ') : 'เลือกประเภทรถ'}
        </span>
        <ChevronDown
          className={cn(
            'h-4 w-4 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-180',
          )}
        />
      </button>

      {open && !disabled && (
        <div
          id={`${id}-options`}
          role="group"
          aria-label="เลือกประเภทรถ"
          className="absolute z-[60] mt-2 max-h-52 w-full overflow-y-auto rounded-xl border border-white/10 bg-popover backdrop-blur-md shadow-2xl shadow-black/40"
        >
          {VEHICLE_TYPE_OPTIONS.map((option) => {
            const selected = selectedVehicleTypes.has(option)
            return (
              <button
                key={option}
                type="button"
                aria-pressed={selected}
                onClick={() => toggleValue(option)}
                className="flex min-h-11 w-full items-center gap-3 px-3 py-3 text-left text-sm text-foreground transition-colors hover:bg-[color:var(--color-info-soft)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              >
                <span
                  className={cn(
                    'flex h-5 w-5 items-center justify-center rounded-md border transition-colors',
                    selected
                      ? 'border-info bg-info text-[color:var(--color-info-foreground)]'
                      : 'border-white/15 bg-white/5 text-transparent',
                  )}
                >
                  <Check className="h-3.5 w-3.5" />
                </span>
                <span>{option}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
