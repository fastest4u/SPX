import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { rulesApi } from '../lib/api'
import type { NotifyRule, RulePatch } from '../types'
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
import { Loader2 } from 'lucide-react'

interface EditRuleDialogProps {
  rule: NotifyRule | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function EditRuleDialog({ rule, open, onOpenChange }: EditRuleDialogProps) {
  const queryClient = useQueryClient()
  const [formData, setFormData] = useState<RulePatch>({})
  const [originsText, setOriginsText] = useState('')
  const [destinationsText, setDestinationsText] = useState('')

  // Reset form when rule changes
  const handleOpenChange = (open: boolean) => {
    if (!open) {
      setFormData({})
      setOriginsText('')
      setDestinationsText('')
    }
    onOpenChange(open)
  }

  useEffect(() => {
    if (open && rule) {
      setFormData({
        name: rule.name,
        origins: rule.origins,
        destinations: rule.destinations,
        vehicle_types: rule.vehicle_types,
        need: rule.need,
        enabled: rule.enabled,
        auto_accept: rule.auto_accept,
      })
      setOriginsText(rule.origins.join(', '))
      setDestinationsText(rule.destinations.join(', '))
    }
  }, [open, rule])

  const updateMutation = useMutation({
    mutationFn: (data: RulePatch) => {
      if (!rule) throw new Error('No rule selected')
      return rulesApi.update(rule.id, data)
    },
    onSuccess: () => {
      toast.success('อัปเดตรายการสำเร็จ', {
        description: `แก้ไข ${rule?.name} เรียบร้อยแล้ว`,
      })
      queryClient.invalidateQueries({ queryKey: ['rules'] })
      onOpenChange(false)
      setFormData({})
      setOriginsText('')
      setDestinationsText('')
    },
    onError: (error: Error) => {
      toast.error('อัปเดตไม่สำเร็จ', {
        description: error.message,
      })
    },
  })

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    updateMutation.mutate({
      ...formData,
      origins: splitCsv(originsText),
      destinations: splitCsv(destinationsText),
    })
  }

  if (!rule) return null

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="sm:max-w-[500px]"
        onInteractOutside={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
      >
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>แก้ไขรายการค้นหา</DialogTitle>
            <DialogDescription>
              แก้ไขเงื่อนไขการค้นหางานสำหรับ {rule.name}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-4">
            {/* Rule Name */}
            <div className="grid gap-2">
              <Label htmlFor="name">ชื่อรายการ</Label>
              <Input
                id="name"
                value={formData.name ?? rule.name}
                onChange={e => setFormData(prev => ({ ...prev, name: e.target.value }))}
                placeholder="เช่น สุวรรณภูมิ 4ล้อ"
                className="bg-slate-900/50 border-white/10"
              />
            </div>

            {/* Origins */}
            <div className="grid gap-2">
              <Label htmlFor="origins">ต้นทาง (คั่นด้วยลูกน้ำ)</Label>
              <Input
                id="origins"
                value={originsText}
                onChange={e => setOriginsText(e.target.value)}
                placeholder="เช่น NERC-C, สุวรรณภูมิ"
                className="bg-slate-900/50 border-white/10"
              />
            </div>

            {/* Destinations */}
            <div className="grid gap-2">
              <Label htmlFor="destinations">ปลายทาง (คั่นด้วยลูกน้ำ)</Label>
              <Input
                id="destinations"
                value={destinationsText}
                onChange={e => setDestinationsText(e.target.value)}
                placeholder="เช่น สุวรรณภูมิ, ดอนเมือง"
                className="bg-slate-900/50 border-white/10"
              />
            </div>

            {/* Vehicle Types */}
            <div className="grid gap-2">
              <Label htmlFor="vehicle_types">ประเภทรถ</Label>
              <VehicleTypeMultiSelect
                id="vehicle_types"
                value={formData.vehicle_types ?? rule.vehicle_types}
                onChange={vehicleTypes => setFormData(prev => ({ ...prev, vehicle_types: vehicleTypes }))}
              />
            </div>

            {/* Need */}
            <div className="grid gap-2">
              <Label htmlFor="need">จำนวนที่ต้องการ (คัน)</Label>
              <Input
                id="need"
                type="number"
                min={1}
                value={formData.need ?? rule.need}
                onChange={e => setFormData(prev => ({ ...prev, need: parseInt(e.target.value) || 1 }))}
                className="bg-slate-900/50 border-white/10"
              />
            </div>

            {/* Enabled Toggle */}
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="enabled"
                checked={formData.enabled ?? rule.enabled}
                onChange={e => setFormData(prev => ({ ...prev, enabled: e.target.checked }))}
                className="h-4 w-4 rounded border-slate-600 bg-slate-900 text-cyan-500 focus:ring-cyan-500 focus:ring-offset-slate-900"
              />
              <Label htmlFor="enabled" className="cursor-pointer">
                เปิดใช้งานรายการนี้
              </Label>
            </div>

            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="auto_accept"
                checked={formData.auto_accept ?? rule.auto_accept}
                onChange={e => setFormData(prev => ({ ...prev, auto_accept: e.target.checked }))}
                className="h-4 w-4 rounded border-slate-600 bg-slate-900 text-cyan-500 focus:ring-cyan-500 focus:ring-offset-slate-900"
              />
              <Label htmlFor="auto_accept" className="cursor-pointer">
                รับงานอัตโนมัติเมื่อ match
              </Label>
            </div>
          </div>

          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={updateMutation.isPending}
              className="border-white/10 bg-white/5 hover:bg-white/10"
            >
              ยกเลิก
            </Button>
            <Button
              type="submit"
              disabled={updateMutation.isPending}
              className="bg-linear-to-r from-cyan-500 to-cyan-600 hover:from-cyan-400 hover:to-cyan-500"
            >
              {updateMutation.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  กำลังบันทึก...
                </>
              ) : (
                'บันทึกการแก้ไข'
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
