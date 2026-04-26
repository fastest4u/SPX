import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { rulesApi } from '../lib/api'
import type { RuleInput } from '../types'
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
  const [formData, setFormData] = useState<RuleInput>(defaultFormData)
  const [originsText, setOriginsText] = useState('')
  const [destinationsText, setDestinationsText] = useState('')

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      setFormData(defaultFormData)
      setOriginsText('')
      setDestinationsText('')
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
      setFormData(defaultFormData)
      setOriginsText('')
      setDestinationsText('')
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
    createMutation.mutate({
      ...formData,
      origins: splitCsv(originsText),
      destinations: splitCsv(destinationsText),
    })
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-full bg-cyan-500/10">
                <Plus className="h-5 w-5 text-cyan-400" />
              </div>
              <div>
                <DialogTitle className="text-white">เพิ่มรายการค้นหาใหม่</DialogTitle>
                <DialogDescription>
                  สร้าง rule สำหรับค้นหาและแจ้งเตือนงานอัตโนมัติ
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>

          <div className="grid gap-4 py-4">
            {/* Rule Name */}
            <div className="grid gap-2">
              <Label htmlFor="create-name">
                ชื่อรายการ <span className="text-red-400">*</span>
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
                className="h-4 w-4 rounded border-slate-600 bg-slate-900 text-cyan-500 focus:ring-cyan-500 focus:ring-offset-slate-900"
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
              onClick={() => onOpenChange(false)}
              disabled={createMutation.isPending}
              className="border-white/10 bg-white/5 hover:bg-white/10"
            >
              ยกเลิก
            </Button>
            <Button
              type="submit"
              disabled={createMutation.isPending || !formData.name.trim()}
              className="bg-gradient-to-r from-cyan-500 to-cyan-600 hover:from-cyan-400 hover:to-cyan-500"
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
