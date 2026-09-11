import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { rulesApi } from '../lib/api'
import { ruleReviewKey } from '../lib/rule-review'
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
import { RuleReviewSummary } from './RuleReviewSummary'

interface Props {
  rule: NotifyRule | null
  open: boolean
  onOpenChange: (open: boolean) => void
}
export function RulePreviewDialog(props: Props) {
  return props.open ? <PreviewContent {...props} /> : null
}

function PreviewContent({ rule, open, onOpenChange }: Props) {
  const [opener] = useState(() =>
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  )
  const preview = useQuery({
    queryKey: ['rule-preview', rule ? ruleReviewKey(rule, rule.id) : null],
    queryFn: ({ signal }) => {
      if (!rule) throw new Error('กรุณาเลือกรายการ')
      return rulesApi.preview(rule, { ruleId: rule.id, limit: 200, sampleLimit: 8, signal })
    },
    enabled: open && !!rule,
    staleTime: 0,
    retry: false,
  })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        closeLabel="ปิดหน้าต่าง"
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          if (opener?.isConnected) opener.focus()
        }}
        className="max-h-[calc(100dvh_-_2rem)] w-[calc(100%_-_2rem)] overflow-y-auto p-4 sm:max-w-[640px] sm:p-6"
      >
        <DialogHeader className="pr-7 text-left">
          <DialogTitle>ตรวจผลกฎจากประวัติ</DialogTitle>
          <DialogDescription>ดูเงื่อนไขและตัวอย่าง โดยไม่เปลี่ยนสถานะการรับงาน</DialogDescription>
        </DialogHeader>
        {preview.isFetching ? (
          <p role="status" className="py-8 text-center text-sm text-muted-foreground">
            กำลังตรวจผล…
          </p>
        ) : preview.isError ? (
          <div role="alert" className="space-y-3 text-sm">
            <p className="break-words text-danger">ตรวจผลไม่สำเร็จ: {preview.error.message}</p>
            <Button variant="outline" onClick={() => void preview.refetch()}>
              ลองใหม่
            </Button>
          </div>
        ) : rule && preview.data ? (
          <RuleReviewSummary input={rule} preview={preview.data} />
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            ปิด
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
