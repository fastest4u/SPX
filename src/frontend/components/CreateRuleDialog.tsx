import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { rulesApi, teamsApi } from '../lib/api'
import type { RuleInput } from '../types'
import { useAuth } from '../hooks/useAuth'
import { Button } from './ui/button'
import { splitCsv } from '../lib/utils'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog'
import { Input } from './ui/input'
import { Label } from './ui/label'
import { VehicleTypeMultiSelect } from './VehicleTypeMultiSelect'
import { toast } from 'sonner'
import { Loader2, Plus } from 'lucide-react'

interface CreateRuleDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

const defaultFormData: RuleInput = {
  name: '',
  origins: [],
  destinations: [],
  vehicle_types: [],
  need: 1,
  enabled: true,
}

export function CreateRuleDialog({ open, onOpenChange }: CreateRuleDialogProps) {
  const queryClient = useQueryClient()
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const [formData, setFormData] = useState<RuleInput>(defaultFormData)
  const [selectedTeamId, setSelectedTeamId] = useState<number | ''>('')
  const [originsText, setOriginsText] = useState('')
  const [destinationsText, setDestinationsText] = useState('')

  const { data: teams = [], isLoading: teamsLoading, isError: teamsError } = useQuery({
    queryKey: ['teams'],
    queryFn: teamsApi.list,
    enabled: open && isAdmin,
    staleTime: 2 * 60 * 1000,
  })

  const resetForm = () => {
    setFormData(defaultFormData)
    setSelectedTeamId('')
    setOriginsText('')
    setDestinationsText('')
  }

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      resetForm()
    }
    onOpenChange(open)
  }

  const createMutation = useMutation({
    mutationFn: (data: RuleInput) => rulesApi.create(data),
    onSuccess: () => {
      toast.success('สร้างรายการสำเร็จ', {
        description: `เพิ่ม ${formData.name} เรียบร้อยแล้ว`,
      })
      queryClient.invalidateQueries({ queryKey: ['rules'] })
      onOpenChange(false)
      resetForm()
    },
    onError: (error: Error) => {
      toast.error('สร้างไม่สำเร็จ', {
        description: error.message,
      })
    },
  })

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!formData.name.trim()) {
      toast.error('กรุณากรอกชื่อรายการ')
      return
    }
    if (isAdmin && typeof selectedTeamId !== 'number') {
      toast.error('กรุณาเลือกทีมเจ้าของเส้นทาง')
      return
    }
    createMutation.mutate({
      ...formData,
      teamId: isAdmin && typeof selectedTeamId === 'number' ? selectedTeamId : undefined,
      origins: splitCsv(originsText),
      destinations: splitCsv(destinationsText),
    })
  }

  const createDisabled =
    createMutation.isPending ||
    !formData.name.trim() ||
    (isAdmin && (teamsLoading || typeof selectedTeamId !== 'number'))

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="sm:max-w-[500px]"
        onInteractOutside={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
      >
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-full bg-[color:var(--color-info-soft)]">
                <Plus className="h-5 w-5 text-info" />
              </div>
              <div>
                <DialogTitle className="text-foreground">เพิ่มรายการค้นหาใหม่</DialogTitle>
                <DialogDescription>
                  สร้าง rule สำหรับค้นหาและรับงานอัตโนมัติ
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>

          <div className="grid gap-4 py-4">
            {/* Rule Name */}
            <div className="grid gap-2">
              <Label htmlFor="create-name">
                ชื่อรายการ <span className="text-danger">*</span>
              </Label>
              <Input
                id="create-name"
                value={formData.name}
                onChange={e => setFormData(prev => ({ ...prev, name: e.target.value }))}
                placeholder="เช่น สุวรรณภูมิ 4ล้อ"
                className="bg-slate-900/50 border-white/10"
                autoFocus
              />
            </div>

            {isAdmin ? (
              <div className="grid gap-2">
                <Label htmlFor="create-team">
                  ทีมเจ้าของเส้นทาง <span className="text-danger">*</span>
                </Label>
                <select
                  id="create-team"
                  value={selectedTeamId}
                  onChange={e => setSelectedTeamId(e.target.value ? Number(e.target.value) : '')}
                  disabled={teamsLoading || createMutation.isPending}
                  className="flex h-11 w-full rounded-xl border border-white/10 bg-slate-900/50 px-3.5 py-2 text-base text-foreground transition-all duration-200 hover:border-white/20 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 sm:text-sm"
                >
                  <option value="">เลือกทีม</option>
                  {teams.map(team => (
                    <option key={team.id} value={team.id}>{team.name}</option>
                  ))}
                </select>
                {teamsError ? (
                  <p className="text-xs text-danger">โหลดรายชื่อทีมไม่สำเร็จ</p>
                ) : null}
              </div>
            ) : null}

            {/* Origins */}
            <div className="grid gap-2">
              <Label htmlFor="create-origins">ต้นทาง (คั่นด้วยลูกน้ำ)</Label>
              <Input
                id="create-origins"
                value={originsText}
                onChange={e => setOriginsText(e.target.value)}
                placeholder="เช่น NERC-C, สุวรรณภูมิ"
                className="bg-slate-900/50 border-white/10"
              />
            </div>

            {/* Destinations */}
            <div className="grid gap-2">
              <Label htmlFor="create-destinations">ปลายทาง (คั่นด้วยลูกน้ำ)</Label>
              <Input
                id="create-destinations"
                value={destinationsText}
                onChange={e => setDestinationsText(e.target.value)}
                placeholder="เช่น สุวรรณภูมิ, ดอนเมือง"
                className="bg-slate-900/50 border-white/10"
              />
            </div>

            {/* Vehicle Types */}
            <div className="grid gap-2">
              <Label htmlFor="create-vehicle_types">ประเภทรถ</Label>
              <VehicleTypeMultiSelect
                id="create-vehicle_types"
                value={formData.vehicle_types}
                onChange={vehicleTypes => setFormData(prev => ({ ...prev, vehicle_types: vehicleTypes }))}
              />
            </div>

            {/* Need */}
            <div className="grid gap-2">
              <Label htmlFor="create-need">จำนวนที่ต้องการ (คัน)</Label>
              <Input
                id="create-need"
                type="number"
                min={1}
                value={formData.need}
                onChange={e => setFormData(prev => ({ ...prev, need: parseInt(e.target.value) || 1 }))}
                className="bg-slate-900/50 border-white/10"
              />
            </div>

            {/* Enabled Toggle */}
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="create-enabled"
                checked={formData.enabled}
                onChange={e => setFormData(prev => ({ ...prev, enabled: e.target.checked }))}
                className="h-4 w-4 rounded border-white/15 bg-white/10 text-info focus:ring-info focus:ring-offset-background"
              />
              <Label htmlFor="create-enabled" className="cursor-pointer">
                เปิดใช้งานทันที
              </Label>
            </div>

          </div>

          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={createMutation.isPending}
              className="border-white/10 bg-white/5 hover:bg-white/10"
            >
              ยกเลิก
            </Button>
            <Button
              type="submit"
              disabled={createDisabled}
              className=""
            >
              {createMutation.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  กำลังสร้าง...
                </>
              ) : (
                <>
                  <Plus className="mr-2 h-4 w-4" />
                  สร้างรายการ
                </>
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
