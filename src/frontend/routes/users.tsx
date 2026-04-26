import { createRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { rootRoute } from './__root'
import { usersApi } from '../lib/api'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card'
import { Button } from '../components/ui/button'
import { formatDateTime } from '../lib/utils'
import { Plus, Users as UsersIcon, Lock, UserCog } from 'lucide-react'

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: '/users',
  component: UsersComponent,
})

function UsersComponent() {
  const { data: users = [] } = useQuery({
    queryKey: ['users'],
    queryFn: usersApi.list,
  })

  const getRoleBadge = (role: string) => {
    const colors: Record<string, string> = {
      admin: 'border-rose-400/20 bg-rose-400/10 text-rose-400',
      editor: 'border-cyan-400/20 bg-cyan-400/10 text-cyan-400',
      viewer: 'border-slate-400/20 bg-slate-400/10 text-slate-400',
    }
    return (
      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border ${colors[role] || colors.viewer}`}>
        {role}
      </span>
    )
  }

  return (
    <div className="space-y-6">
      <Card className="glass border-white/10">
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle className="text-white">จัดการผู้ใช้งาน</CardTitle>
            <p className="text-sm text-muted-foreground">
              เพิ่มผู้ใช้ใหม่ เปลี่ยนรหัสผ่าน และกำหนด role
            </p>
          </div>
          <Button className="bg-cyan-500 hover:bg-cyan-600">
            <Plus className="h-4 w-4 mr-2" />
            เพิ่มผู้ใช้
          </Button>
        </CardHeader>
        <CardContent>
          {users.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <UsersIcon className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p>ไม่พบผู้ใช้งาน</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-white/10 text-left text-sm text-muted-foreground">
                    <th className="pb-3 font-medium">ID</th>
                    <th className="pb-3 font-medium">ชื่อผู้ใช้</th>
                    <th className="pb-3 font-medium">Role</th>
                    <th className="pb-3 font-medium">วันที่สร้าง</th>
                    <th className="pb-3 font-medium">จัดการ</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((user) => (
                    <tr key={user.id} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                      <td className="py-3 text-muted-foreground">{user.id}</td>
                      <td className="py-3 text-white font-medium">{user.username}</td>
                      <td className="py-3">{getRoleBadge(user.role)}</td>
                      <td className="py-3 text-muted-foreground">{formatDateTime(user.createdAt)}</td>
                      <td className="py-3">
                        <div className="flex gap-2">
                          <Button variant="ghost" size="sm" className="h-8 text-xs text-amber-400 hover:text-amber-300">
                            <Lock className="h-3 w-3 mr-1" />
                            รหัสผ่าน
                          </Button>
                          <Button variant="ghost" size="sm" className="h-8 text-xs">
                            <UserCog className="h-3 w-3 mr-1" />
                            Role
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
