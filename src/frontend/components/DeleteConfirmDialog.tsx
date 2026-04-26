import { useMutation, useQueryClient } from '@tanstack/react-query'
import { rulesApi } from '../lib/api'
import type { NotifyRule } from '../types'
import { Button } from './ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog'
import { toast } from 'sonner'
import { Loader2, AlertTriangle } from 'lucide-react'

interface DeleteConfirmDialogProps {
  rule: NotifyRule | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function DeleteConfirmDialog({ rule, open, onOpenChange }: DeleteConfirmDialogProps) {
  const queryClient = useQueryClient()

  const deleteMutation = useMutation({
    mutationFn: () => {
      if (!rule) throw new Error('No rule selected')
      return rulesApi.delete(rule.id)
    },
    onSuccess: () => {
      toast.success('ลบรายการสำเร็จ', {
        description: `ลบ ${rule?.name} เรียบร้อยแล้ว`,
      })
      queryClient.invalidateQueries({ queryKey: ['rules'] })
      onOpenChange(false)
    },
    onError: (error: Error) => {
      toast.error('ลบไม่สำเร็จ', {
        description: error.message,
      })
    },
  })

  const handleDelete = () => {
    deleteMutation.mutate()
  }

  if (!rule) return null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-full bg-red-500/10">
              <AlertTriangle className="h-6 w-6 text-red-400" />
            </div>
            <DialogTitle className="text-white">ยืนยันการลบ</DialogTitle>
          </div>
          <DialogDescription className="pt-2">
            คุณแน่ใจหรือไม่ที่จะลบรายการ <strong className="text-white">{rule.name}</strong>?
            <br />
            <span className="text-red-400">การกระทำนี้ไม่สามารถย้อนกลับได้</span>
          </DialogDescription>
        </DialogHeader>

        <DialogFooter className="gap-2 mt-4">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={deleteMutation.isPending}
            className="border-white/10 bg-white/5 hover:bg-white/10"
          >
            ยกเลิก
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={handleDelete}
            disabled={deleteMutation.isPending}
            className="bg-red-600 hover:bg-red-500"
          >
            {deleteMutation.isPending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                กำลังลบ...
              </>
            ) : (
              'ลบรายการ'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
