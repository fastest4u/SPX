import { createRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent, type ReactNode } from 'react'
import { toast } from 'sonner'
import { rootRoute } from './__root'
import { usersApi } from '../lib/api'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog'
import { formatDateTime } from '../lib/utils'
import { AlertTriangle, Loader2, Lock, Plus, Trash2, UserCog, Users as UsersIcon } from 'lucide-react'
import type { User } from '../types'
import { useAuth } from '../hooks/useAuth'

type UserRole = User['role']

const MIN_PASSWORD_LENGTH = 12
const roles: UserRole[] = ['user', 'admin']
const selectClassName = 'flex h-11 w-full rounded-xl border border-white/10 bg-white/5 px-3.5 py-2 text-base text-white transition-all duration-200 hover:border-white/20 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background sm:text-sm'

function getRoleBadge(role: string) {
  const colors: Record<string, string> = {
    admin: 'border-rose-400/20 bg-rose-400/10 text-rose-300',
    user: 'border-cyan-400/20 bg-cyan-400/10 text-cyan-300',
  }
  return (
    <span className={`status-pill ${colors[role] || colors.user}`}>
      {role}
    </span>
  )
}

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: '/users',
  component: UsersComponent,
})

function UsersComponent() {
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const { user: currentUser } = useAuth()
  const { data: users = [], isLoading, isError, error } = useQuery({
    queryKey: ['users'],
    queryFn: usersApi.list,
  })

  return (
    <div className="space-y-5 sm:space-y-6">
      <Card className="glass border-white/10">
        <CardHeader className="gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle className="text-white">จัดการผู้ใช้งาน</CardTitle>
            <p className="text-sm text-muted-foreground">
              เพิ่มผู้ใช้ใหม่ เปลี่ยนรหัสผ่าน กำหนด role และลบผู้ใช้ที่ไม่ต้องใช้งานแล้ว
            </p>
          </div>
          <Button
            className="w-full bg-gradient-to-r from-emerald-400 to-cyan-400 text-slate-950 shadow-lg shadow-cyan-500/20 hover:from-emerald-300 hover:to-cyan-300 sm:w-auto"
            onClick={() => setCreateDialogOpen(true)}
          >
            <Plus className="h-4 w-4 mr-2" />
            เพิ่มผู้ใช้
          </Button>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] py-14 text-center text-muted-foreground">
              <Loader2 className="h-10 w-10 mx-auto mb-4 animate-spin text-cyan-300" />
              <p>กำลังโหลดผู้ใช้งาน...</p>
            </div>
          ) : isError ? (
            <div className="rounded-2xl border border-red-400/20 bg-red-400/10 p-5 text-red-200">
              <div className="mb-2 flex items-center gap-2 font-semibold">
                <AlertTriangle className="h-5 w-5" />
                โหลดข้อมูลผู้ใช้ไม่สำเร็จ
              </div>
              <p className="text-sm text-red-100/80">
                {error instanceof Error ? error.message : 'เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ'}
              </p>
            </div>
          ) : users.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.03] py-14 text-center text-muted-foreground">
              <UsersIcon className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p>ไม่พบผู้ใช้งาน</p>
            </div>
          ) : (
            <>
              <div className="grid gap-3 md:hidden">
                {users.map((user) => (
                  <UserMobileCard key={user.id} user={user} currentUserId={currentUser?.id} />
                ))}
              </div>
              <div className="data-scroll hidden md:block">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>ID</th>
                      <th>ชื่อผู้ใช้</th>
                      <th>Role</th>
                      <th>วันที่สร้าง</th>
                      <th>จัดการ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.map((user) => (
                      <tr key={user.id}>
                        <td className="text-muted-foreground">{user.id}</td>
                        <td>
                          <UserIdentity user={user} currentUserId={currentUser?.id} />
                        </td>
                        <td>{getRoleBadge(user.role)}</td>
                        <td className="text-muted-foreground">{formatDateTime(user.createdAt)}</td>
                        <td>
                          <UserActions user={user} currentUserId={currentUser?.id} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <CreateUserDialog open={createDialogOpen} onOpenChange={setCreateDialogOpen} />
    </div>
  )
}

function UserActions({ user, currentUserId }: { user: User; currentUserId?: number }) {
  const [passwordDialogOpen, setPasswordDialogOpen] = useState(false)
  const [roleDialogOpen, setRoleDialogOpen] = useState(false)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const isCurrentUser = user.id === currentUserId

  return (
    <>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="ghost"
          size="sm"
          className="h-10 text-xs text-amber-300 hover:text-amber-200"
          onClick={() => setPasswordDialogOpen(true)}
        >
          <Lock className="h-3 w-3 mr-1" />
          รหัสผ่าน
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-10 text-xs"
          onClick={() => setRoleDialogOpen(true)}
          disabled={isCurrentUser}
        >
          <UserCog className="h-3 w-3 mr-1" />
          Role
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-10 text-xs text-red-300 hover:text-red-200"
          onClick={() => setDeleteDialogOpen(true)}
          disabled={isCurrentUser}
        >
          <Trash2 className="h-3 w-3 mr-1" />
          ลบ
        </Button>
      </div>

      <PasswordDialog user={user} open={passwordDialogOpen} onOpenChange={setPasswordDialogOpen} />
      <RoleDialog user={user} open={roleDialogOpen} onOpenChange={setRoleDialogOpen} />
      <DeleteUserDialog user={user} open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen} />
    </>
  )
}

function UserIdentity({ user, currentUserId }: { user: User; currentUserId?: number }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="font-semibold text-white">{user.username}</span>
      {user.id === currentUserId && (
        <span className="rounded-full border border-emerald-300/20 bg-emerald-300/10 px-2 py-0.5 text-xs font-bold text-emerald-300">
          คุณ
        </span>
      )}
    </div>
  )
}

function UserMobileCard({ user, currentUserId }: { user: User; currentUserId?: number }) {
  return (
    <div className="mobile-record">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <div className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">ผู้ใช้</div>
          <div className="mt-1">
            <UserIdentity user={user} currentUserId={currentUserId} />
          </div>
        </div>
        {getRoleBadge(user.role)}
      </div>
      <div className="grid gap-3 text-sm">
        <InfoItem label="ID" value={String(user.id)} />
        <InfoItem label="วันที่สร้าง" value={formatDateTime(user.createdAt)} />
      </div>
      <div className="mt-4 border-t border-white/10 pt-4">
        <UserActions user={user} currentUserId={currentUserId} />
      </div>
    </div>
  )
}

function InfoItem({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <div className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">{label}</div>
      <div className="mt-1 text-slate-200">{value}</div>
    </div>
  )
}

function CreateUserDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<UserRole>('user')

  const reset = () => {
    setUsername('')
    setPassword('')
    setRole('user')
  }

  const createMutation = useMutation({
    mutationFn: () => usersApi.create({ username: username.trim(), password, role }),
    onSuccess: () => {
      toast.success('เพิ่มผู้ใช้สำเร็จ', {
        description: `สร้างบัญชี ${username.trim()} แล้ว`,
      })
      queryClient.invalidateQueries({ queryKey: ['users'] })
      reset()
      onOpenChange(false)
    },
    onError: (error: Error) => {
      toast.error('เพิ่มผู้ใช้ไม่สำเร็จ', {
        description: error.message,
      })
    },
  })

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && !createMutation.isPending) reset()
    onOpenChange(nextOpen)
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!username.trim()) {
      toast.error('กรุณากรอกชื่อผู้ใช้')
      return
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      toast.error(`รหัสผ่านต้องมีอย่างน้อย ${MIN_PASSWORD_LENGTH} ตัวอักษร`)
      return
    }
    createMutation.mutate()
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>เพิ่มผู้ใช้ใหม่</DialogTitle>
            <DialogDescription>
              สร้างบัญชีสำหรับเข้าใช้งานระบบและกำหนดสิทธิ์เริ่มต้น
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="create-user-username">ชื่อผู้ใช้</Label>
              <Input
                id="create-user-username"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                placeholder="username"
                autoComplete="username"
                autoFocus
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="create-user-password">รหัสผ่าน</Label>
              <Input
                id="create-user-password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="อย่างน้อย 12 ตัวอักษร"
                autoComplete="new-password"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="create-user-role">Role</Label>
              <select
                id="create-user-role"
                className={selectClassName}
                value={role}
                onChange={(event) => setRole(event.target.value as UserRole)}
              >
                {roles.map((roleOption) => (
                  <option key={roleOption} value={roleOption}>
                    {roleOption}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="outline"
              className="w-full sm:w-auto"
              onClick={() => handleOpenChange(false)}
              disabled={createMutation.isPending}
            >
              ยกเลิก
            </Button>
            <Button
              type="submit"
              className="w-full bg-gradient-to-r from-emerald-400 to-cyan-400 text-slate-950 hover:from-emerald-300 hover:to-cyan-300 sm:w-auto"
              disabled={createMutation.isPending}
            >
              {createMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  กำลังเพิ่ม...
                </>
              ) : (
                'เพิ่มผู้ใช้'
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function PasswordDialog({
  user,
  open,
  onOpenChange,
}: {
  user: User
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')

  const reset = () => {
    setPassword('')
    setConfirmPassword('')
  }

  const passwordMutation = useMutation({
    mutationFn: () => usersApi.updatePassword(user.id, password),
    onSuccess: () => {
      toast.success('เปลี่ยนรหัสผ่านสำเร็จ', {
        description: `อัปเดตรหัสผ่านของ ${user.username} แล้ว`,
      })
      reset()
      onOpenChange(false)
    },
    onError: (error: Error) => {
      toast.error('เปลี่ยนรหัสผ่านไม่สำเร็จ', {
        description: error.message,
      })
    },
  })

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && !passwordMutation.isPending) reset()
    onOpenChange(nextOpen)
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (password.length < MIN_PASSWORD_LENGTH) {
      toast.error(`รหัสผ่านต้องมีอย่างน้อย ${MIN_PASSWORD_LENGTH} ตัวอักษร`)
      return
    }
    if (password !== confirmPassword) {
      toast.error('รหัสผ่านยืนยันไม่ตรงกัน')
      return
    }
    passwordMutation.mutate()
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>เปลี่ยนรหัสผ่าน</DialogTitle>
            <DialogDescription>
              ตั้งรหัสผ่านใหม่สำหรับ {user.username}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor={`password-${user.id}`}>รหัสผ่านใหม่</Label>
              <Input
                id={`password-${user.id}`}
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="อย่างน้อย 12 ตัวอักษร"
                autoComplete="new-password"
                autoFocus
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor={`confirm-password-${user.id}`}>ยืนยันรหัสผ่าน</Label>
              <Input
                id={`confirm-password-${user.id}`}
                type="password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                placeholder="กรอกรหัสผ่านอีกครั้ง"
                autoComplete="new-password"
              />
            </div>
          </div>

          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="outline"
              className="w-full sm:w-auto"
              onClick={() => handleOpenChange(false)}
              disabled={passwordMutation.isPending}
            >
              ยกเลิก
            </Button>
            <Button
              type="submit"
              className="w-full bg-gradient-to-r from-emerald-400 to-cyan-400 text-slate-950 hover:from-emerald-300 hover:to-cyan-300 sm:w-auto"
              disabled={passwordMutation.isPending}
            >
              {passwordMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  กำลังบันทึก...
                </>
              ) : (
                'บันทึกรหัสผ่าน'
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function RoleDialog({
  user,
  open,
  onOpenChange,
}: {
  user: User
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const [role, setRole] = useState<UserRole>(user.role)

  const roleMutation = useMutation({
    mutationFn: () => usersApi.updateRole(user.id, role),
    onSuccess: () => {
      toast.success('เปลี่ยน role สำเร็จ', {
        description: `${user.username} เป็น ${role} แล้ว`,
      })
      queryClient.invalidateQueries({ queryKey: ['users'] })
      onOpenChange(false)
    },
    onError: (error: Error) => {
      toast.error('เปลี่ยน role ไม่สำเร็จ', {
        description: error.message,
      })
    },
  })

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) setRole(user.role)
    onOpenChange(nextOpen)
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    roleMutation.mutate()
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[440px]">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>กำหนด Role</DialogTitle>
            <DialogDescription>
              เปลี่ยนสิทธิ์ของ {user.username}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-2 py-4">
            <Label htmlFor={`role-${user.id}`}>Role</Label>
            <select
              id={`role-${user.id}`}
              className={selectClassName}
              value={role}
              onChange={(event) => setRole(event.target.value as UserRole)}
              autoFocus
            >
              {roles.map((roleOption) => (
                <option key={roleOption} value={roleOption}>
                  {roleOption}
                </option>
              ))}
            </select>
          </div>

          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="outline"
              className="w-full sm:w-auto"
              onClick={() => handleOpenChange(false)}
              disabled={roleMutation.isPending}
            >
              ยกเลิก
            </Button>
            <Button
              type="submit"
              className="w-full bg-gradient-to-r from-emerald-400 to-cyan-400 text-slate-950 hover:from-emerald-300 hover:to-cyan-300 sm:w-auto"
              disabled={roleMutation.isPending || role === user.role}
            >
              {roleMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  กำลังบันทึก...
                </>
              ) : (
                'บันทึก Role'
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function DeleteUserDialog({
  user,
  open,
  onOpenChange,
}: {
  user: User
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()

  const deleteMutation = useMutation({
    mutationFn: () => usersApi.delete(user.id),
    onSuccess: () => {
      toast.success('ลบผู้ใช้สำเร็จ', {
        description: `ลบ ${user.username} แล้ว`,
      })
      queryClient.invalidateQueries({ queryKey: ['users'] })
      onOpenChange(false)
    },
    onError: (error: Error) => {
      toast.error('ลบผู้ใช้ไม่สำเร็จ', {
        description: error.message,
      })
    },
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="rounded-full bg-red-500/10 p-2">
              <AlertTriangle className="h-6 w-6 text-red-400" />
            </div>
            <DialogTitle>ยืนยันการลบผู้ใช้</DialogTitle>
          </div>
          <DialogDescription className="pt-2">
            คุณแน่ใจหรือไม่ที่จะลบ <strong className="text-white">{user.username}</strong>?
            <br />
            <span className="text-red-300">การกระทำนี้ไม่สามารถย้อนกลับได้</span>
          </DialogDescription>
        </DialogHeader>

        <DialogFooter className="gap-2 pt-4">
          <Button
            type="button"
            variant="outline"
            className="w-full sm:w-auto"
            onClick={() => onOpenChange(false)}
            disabled={deleteMutation.isPending}
          >
            ยกเลิก
          </Button>
          <Button
            type="button"
            variant="destructive"
            className="w-full bg-red-600 hover:bg-red-500 sm:w-auto"
            onClick={() => deleteMutation.mutate()}
            disabled={deleteMutation.isPending}
          >
            {deleteMutation.isPending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                กำลังลบ...
              </>
            ) : (
              'ลบผู้ใช้'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
