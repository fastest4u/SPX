import { createRoute } from '@tanstack/react-router'
import { rootRoute } from './__root'
import { reportsApi } from '../lib/api'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card'
import { Button } from '../components/ui/button'
import { FileBarChart, Download, FileText, Activity } from 'lucide-react'

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: '/reports',
  component: ReportsComponent,
})

function ReportsComponent() {
  return (
    <div className="space-y-6">
      <Card className="glass border-white/10">
        <CardHeader>
          <CardTitle className="text-white">Export รายงาน</CardTitle>
          <p className="text-sm text-muted-foreground">
            ดาวน์โหลดรายงานในรูปแบบ CSV
          </p>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* Metrics Report */}
            <Card className="bg-white/5 border-white/10">
              <CardContent className="p-6">
                <div className="flex items-start justify-between mb-4">
                  <div className="p-2 rounded-lg bg-cyan-500/10">
                    <Activity className="h-5 w-5 text-cyan-400" />
                  </div>
                </div>
                <h3 className="text-lg font-medium text-white mb-2">Metrics Report</h3>
                <p className="text-sm text-muted-foreground mb-4">
                  รายงาน metrics การทำงานของระบบ
                </p>
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={() => reportsApi.downloadMetrics()}
                >
                  <Download className="h-4 w-4 mr-2" />
                  Download CSV
                </Button>
              </CardContent>
            </Card>

            {/* History Report */}
            <Card className="bg-white/5 border-white/10">
              <CardContent className="p-6">
                <div className="flex items-start justify-between mb-4">
                  <div className="p-2 rounded-lg bg-emerald-500/10">
                    <FileText className="h-5 w-5 text-emerald-400" />
                  </div>
                </div>
                <h3 className="text-lg font-medium text-white mb-2">History Report</h3>
                <p className="text-sm text-muted-foreground mb-4">
                  รายงานประวัติการจองและรับงาน
                </p>
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={() => reportsApi.downloadHistory()}
                >
                  <Download className="h-4 w-4 mr-2" />
                  Download CSV
                </Button>
              </CardContent>
            </Card>

            {/* Audit Report */}
            <Card className="bg-white/5 border-white/10">
              <CardContent className="p-6">
                <div className="flex items-start justify-between mb-4">
                  <div className="p-2 rounded-lg bg-violet-500/10">
                    <FileBarChart className="h-5 w-5 text-violet-400" />
                  </div>
                </div>
                <h3 className="text-lg font-medium text-white mb-2">Audit Report</h3>
                <p className="text-sm text-muted-foreground mb-4">
                  รายงานประวัติการใช้งานระบบ
                </p>
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={() => reportsApi.downloadAudit()}
                >
                  <Download className="h-4 w-4 mr-2" />
                  Download CSV
                </Button>
              </CardContent>
            </Card>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
