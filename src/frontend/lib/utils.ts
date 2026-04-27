import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

function parseDateInput(date: string | Date): Date {
  if (date instanceof Date) return date
  const cleaned = date.trim()
  const thaiDateMatch = cleaned.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/)
  if (thaiDateMatch) {
    const [, day, month, year, hour = '0', minute = '0', second = '0'] = thaiDateMatch
    const gregorianYear = Number(year) > 2400 ? Number(year) - 543 : Number(year)
    return new Date(
      `${gregorianYear.toString().padStart(4, '0')}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T${hour.padStart(2, '0')}:${minute.padStart(2, '0')}:${second.padStart(2, '0')}+07:00`
    )
  }
  // ISO string with timezone info
  if (cleaned.endsWith('Z') || cleaned.match(/T.*[+-]\d{2}:?\d{2}$/)) {
    return new Date(cleaned)
  }
  // MySQL DATETIME has no timezone marker; treat it as Bangkok wall time.
  return new Date(`${cleaned.replace(' ', 'T')}+07:00`)
}

export function formatDate(date: string | Date): string {
  const d = parseDateInput(date)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('th-TH', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function formatDateTime(date: string | Date): string {
  const d = parseDateInput(date)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('th-TH', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

export function formatArray(values: unknown): string {
  if (!Array.isArray(values)) return '—'
  if (values.length === 0) return '—'
  return values.join(', ')
}

export function escapeHtml(text: string): string {
  const div = document.createElement('div')
  div.textContent = text
  return div.innerHTML
}

export function splitCsv(value: string): string[] {
  return value
    .normalize('NFKC')
    .replace(/[\p{White_Space}]+/gu, ' ')
    .split(/[,，\n]/)
    .map((item) => item.trim())
    .filter(Boolean)
}
