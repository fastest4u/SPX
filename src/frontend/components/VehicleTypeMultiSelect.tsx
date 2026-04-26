import { useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { cn } from '../lib/utils'

const VEHICLE_TYPE_OPTIONS = [
  '6WH-6ล้อ[7.2m]',
  '4WH-4ล้อ',
]

interface VehicleTypeMultiSelectProps {
  id: string
  value: string[]
  onChange: (value: string[]) => void
}

export function VehicleTypeMultiSelect({ id, value, onChange }: VehicleTypeMultiSelectProps) {
  const [open, setOpen] = useState(false)
  const selectedVehicleTypes = new Set(value)

  const toggleValue = (option: string) => {
    onChange(selectedVehicleTypes.has(option) ? value.filter((item) => item !== option) : [...value, option])
  }

  return (
    <div className="relative">
      <button
        id={id}
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="flex min-h-10 w-full items-center justify-between gap-3 rounded-md border border-white/10 bg-slate-900/50 px-3 py-2 text-left text-sm text-white ring-offset-background transition-colors hover:border-cyan-400/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        <span className={cn('line-clamp-2', value.length === 0 && 'text-muted-foreground')}>
          {value.length > 0 ? value.join(', ') : 'เลือกประเภทรถ'}
        </span>
        <ChevronDown className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="absolute z-[60] mt-2 w-full overflow-hidden rounded-xl border border-white/10 bg-slate-950 shadow-2xl shadow-black/40">
          {VEHICLE_TYPE_OPTIONS.map((option) => {
            const selected = selectedVehicleTypes.has(option)
            return (
              <button
                key={option}
                type="button"
                onClick={() => toggleValue(option)}
                className="flex w-full items-center gap-3 px-3 py-3 text-left text-sm text-slate-200 transition-colors hover:bg-cyan-400/10 hover:text-white"
              >
                <span
                  className={cn(
                    'flex h-5 w-5 items-center justify-center rounded-md border transition-colors',
                    selected ? 'border-cyan-400 bg-cyan-400 text-slate-950' : 'border-white/15 bg-white/5 text-transparent'
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
