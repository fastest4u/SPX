export const ALL_HISTORY_FILTER_VALUE = 'all'

export type HistorySelectOption = {
  value: string
  label: string
}

export function buildHistoryTeamOptions(teams: Array<{ id: number; name: string }>): HistorySelectOption[] {
  const sortedTeams = teams
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, 'th'))

  return [
    { value: ALL_HISTORY_FILTER_VALUE, label: 'ทุกทีม' },
    ...sortedTeams.map((team) => ({ value: String(team.id), label: team.name })),
  ]
}

export function buildHistoryVehicleOptions(vehicleTypes: string[]): HistorySelectOption[] {
  const vehicles = Array.from(
    new Set(vehicleTypes.map((vehicleType) => vehicleType.trim()).filter(Boolean))
  ).sort((a, b) => a.localeCompare(b, 'th'))

  return [
    { value: ALL_HISTORY_FILTER_VALUE, label: 'ทุกประเภท' },
    ...vehicles.map((vehicleType) => ({ value: vehicleType, label: vehicleType })),
  ]
}

export function historyTeamIdFromFilter(value: string): number | undefined {
  if (value === ALL_HISTORY_FILTER_VALUE) return undefined
  const teamId = Number(value)
  return Number.isInteger(teamId) && teamId > 0 ? teamId : undefined
}

export function historyVehicleTypeFromFilter(value: string): string | undefined {
  const trimmed = value.trim()
  return trimmed && trimmed !== ALL_HISTORY_FILTER_VALUE ? trimmed : undefined
}
