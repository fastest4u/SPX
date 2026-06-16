import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import { teamsApi, usersApi } from '../lib/api'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { DataTable, type DataTableColumn } from '../components/DataTable'
import { ContentSection, EmptyPanel, MobileRecordCard, PageShell } from '../components/layout/Page'
import { PageHeader } from '../components/ui/page-header'
import { ErrorState } from '../components/ui/error-state'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog'
import { formatDateTime } from '../lib/utils'
import { SkeletonTable } from '../components/ui/skeleton'
import { AlertTriangle, Loader2, Lock, Plus, Trash2, UserCog, Users as UsersIcon } from 'lucide-react'
import type { Team, User } from '../types'
import { useAuth } from '../hooks/useAuth'

type UserRole = User['role']

const MIN_PASSWORD_LENGTH = 12
const roles: UserRole[] = ['user', 'admin']
const selectClassName = 'flex h-11 w-full rounded-xl border border-white/10 bg-white/5 px-3.5 py-2 text-base text-foreground transition-all duration-200 hover:border-white/20 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background sm:text-sm'

function getRoleBadge(role: string) {
  const colors: Record<string, string> = {
    admin: 'border-[color:var(--color-danger-border)] bg-[color:var(--color-danger-soft)] text-danger',
    user: 'border-[color:var(--color-info-border)] bg-[color:var(--color-info-soft)] text-info',
  }
  return (
    <span className={`status-pill ${colors[role] || colors.user}`}>
      {role}
    </span>
  )
}

export const Route = createFileRoute('/users')({
  component: UsersComponent,
})

function UsersComponent() {
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const { user: currentUser } = useAuth()
  const { data: teams = [] } = useQuery({
    queryKey: ['teams'],
    queryFn: teamsApi.list,
    staleTime: 5 * 60 * 1000,
  })
  const { data: users = [], isLoading, isError, error, refetch } = useQuery({
    queryKey: ['users'],
    queryFn: usersApi.list,
    staleTime: 5 * 60 * 1000,
  })

  if (isLoading) {
    return (
      <PageShell>
        <ContentSection>
          <SkeletonTable rows={5} cols={4} />
        </ContentSection>
      </PageShell>
    )
  }

  const userColumns: DataTableColumn<User>[] = [
    {
      header: 'ID',
      render: (user) => <span className="text-muted-foreground">{user.id}</span>,
    },
    {
      header: 'ชื่อผู้ใช้',
      render: (user) => <UserIdentity user={user} currentUserId={currentUser?.id} />,
    },
    {
      header: 'Role',
      render: (user) => getRoleBadge(user.role),
    },
    {
      header: 'ทีม',
      render: (user) => <TeamBadge user={user} />,
    },
    {
      header: 'วันที่สร้าง',
      render: (user) => <span className="text-muted-foreground">{formatDateTime(user.createdAt)}</span>,
    },
    {
      header: 'จัดการ',
      render: (user) => <UserActions user={user} teams={teams} currentUserId={currentUser?.id} />,
    },
  ]

  return (
    <PageShell>
      <PageHeader
        icon={UsersIcon}
        title="จัดการผู้ใช้งาน"
        subtitle="เพิ่มผู้ใช้ใหม่ เปลี่ยนรหัสผ่าน กำหนด role และลบผู้ใช้ที่ไม่ต้องใช้งานแล้ว"
        actions={
          <Button onClick={() => setCreateDialogOpen(true)}>
            <Plus className="h-4 w-4" />
            เพิ่มผู้ใช้
          </Button>
        }
      />

      <ContentSection>
          {isLoading ? (
            <div className="rounded-[8px] border border-white/10 bg-white/[0.03] py-14 text-center text-muted-foreground">
              <Loader2 className="h-10 w-10 mx-auto mb-4 animate-spin text-info" />
              <p>กำลังโหลดผู้ใช้งาน...</p>
            </div>
          ) : isError ? (
            <ErrorState
              title="โหลดข้อมูลผู้ใช้ไม่สำเร็จ"
              description="ลองกดปุ่มด้านล่างเพื่อลองโหลดอีกครั้ง"
              error={error}
              onRetry={() => refetch()}
            />
          ) : users.length === 0 ? (
            <EmptyPanel icon={<UsersIcon className="h-12 w-12 mx-auto mb-4 opacity-50" />}>ไม่พบผู้ใช้งาน</EmptyPanel>
          ) : (
            <>
              <div className="hidden md:block">
                <DataTable
                  columns={userColumns}
                  data={users}
                  keyField={(user) => user.id}
                  densityKey="users"
                  minWidth="820px"
                />
              </div>
              <div className="grid gap-3 md:hidden">
                {users.map((user) => (
                  <UserMobileCard key={user.id} user={user} teams={teams} currentUserId={currentUser?.id} />
                ))}
              </div>
            </>
          )}
      </ContentSection>

      <CreateUserDialog teams={teams} open={createDialogOpen} onOpenChange={setCreateDialogOpen} />
    </PageShell>
  )
}

function UserActions({ user, teams, currentUserId }: { user: User; teams: Team[]; currentUserId?: number }) {
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
          className="h-10 text-xs text-warning hover:text-warning"
          onClick={() => setPasswordDialogOpen(true)}
        >
          <Lock className="h-3 w-3" />
          รหัสผ่าน
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-10 text-xs"
          onClick={() => setRoleDialogOpen(true)}
          disabled={isCurrentUser}
        >
          <UserCog className="h-3 w-3" />
          Role
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-10 text-xs text-danger hover:text-danger"
          onClick={() => setDeleteDialogOpen(true)}
          disabled={isCurrentUser}
        >
          <Trash2 className="h-3 w-3" />
          ลบ
        </Button>
      </div>

      <PasswordDialog user={user} open={passwordDialogOpen} onOpenChange={setPasswordDialogOpen} />
      <RoleDialog user={user} teams={teams} open={roleDialogOpen} onOpenChange={setRoleDialogOpen} />
      <DeleteUserDialog user={user} open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen} />
    </>
  )
}

function TeamBadge({ user }: { user: User }) {
  if (user.role === 'admin') {
    return <span className="text-xs text-muted-foreground">ทุกทีม</span>
  }
  return (
    <span className="status-pill border-white/10 bg-white/[0.04] text-muted-foreground">
      {user.teamName || (user.teamId ? `Team #${user.teamId}` : 'ไม่ระบุ')}
    </span>
  )
}

function TeamSelect({
  id,
  teams,
  value,
  onChange,
}: {
  id: string
  teams: Team[]
  value: number | null
  onChange: (value: number | null) => void
}) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>ทีม</Label>
      <select
        id={id}
        className={selectClassName}
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value ? Number(event.target.value) : null)}
      >
        <option value="">เลือกทีม</option>
        {teams.map((team) => (
          <option key={team.id} value={team.id}>
            {team.name}
          </option>
        ))}
      </select>
    </div>
  )
}

function UserIdentity({ user, currentUserId }: { user: User; currentUserId?: number }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="font-semibold text-foreground">{user.username}</span>
      {user.id === currentUserId ? (
        <span className="rounded-full border border-[color:var(--color-success-border)] bg-[color:var(--color-success-soft)] px-2 py-0.5 text-xs font-bold text-success">
          คุณ
        </span>
      ) : null}
    </div>
  )
}

function UserMobileCard({ user, teams, currentUserId }: { user: User; teams: Team[]; currentUserId?: number }) {
  return (
    <MobileRecordCard>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <span className="font-data text-xs text-muted-foreground">#{user.id}</span>
          <div className="mt-1">
            <UserIdentity user={user} currentUserId={currentUserId} />
          </div>
        </div>
        <div className="shrink-0">{getRoleBadge(user.role)}</div>
      </div>

      <div className="mt-3 grid gap-2 rounded-[8px] border border-white/[0.06] bg-black/10 p-3 text-xs">
        <div className="flex items-center justify-between gap-3">
          <span className="text-muted-foreground">ทีม</span>
          <div className="min-w-0 text-right"><TeamBadge user={user} /></div>
        </div>
        <div className="flex items-center justify-between gap-3 text-muted-foreground">
          <span>วันที่สร้าง</span>
          <span className="text-right">{formatDateTime(user.createdAt)}</span>
        </div>
      </div>

      <div className="mt-4">
        <UserActions user={user} teams={teams} currentUserId={currentUserId} />
      </div>
    </MobileRecordCard>
  )
}

function CreateUserDialog({
  teams,
  open,
  onOpenChange,
}: {
  teams: Team[]
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<UserRole>('user')
  const [teamId, setTeamId] = useState<number | null>(teams[0]?.id ?? null)

  const reset = () => {
    setUsername('')
    setPassword('')
    setRole('user')
    setTeamId(teams[0]?.id ?? null)
  }

  const createMutation = useMutation({
    mutationFn: () => usersApi.create({ username: username.trim(), password, role, teamId: role === 'user' ? teamId : null }),
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
    if (role === 'user' && typeof teamId !== 'number') {
      toast.error('ผู้ใช้ role user ต้องเลือกทีม')
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
                onChange={(event) => {
                  const nextRole = event.target.value as UserRole
                  setRole(nextRole)
                  if (nextRole === 'admin') setTeamId(null)
                  else if (teamId === null) setTeamId(teams[0]?.id ?? null)
                }}
              >
                {roles.map((roleOption) => (
                  <option key={roleOption} value={roleOption}>
                    {roleOption}
                  </option>
                ))}
              </select>
            </div>
            {role === 'user' ? (
              <TeamSelect
                id="create-user-team"
                teams={teams}
                value={teamId}
                onChange={setTeamId}
              />
            ) : null}
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
              className="w-full sm:w-auto"
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
              className="w-full sm:w-auto"
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
  teams,
  open,
  onOpenChange,
}: {
  user: User
  teams: Team[]
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const [role, setRole] = useState<UserRole>(user.role)
  const [teamId, setTeamId] = useState<number | null>(user.teamId ?? teams[0]?.id ?? null)

  const roleMutation = useMutation({
    mutationFn: () => usersApi.updateRole(user.id, role, role === 'user' ? teamId : null),
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
    if (nextOpen) {
      setRole(user.role)
      setTeamId(user.teamId ?? teams[0]?.id ?? null)
    }
    onOpenChange(nextOpen)
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (role === 'user' && typeof teamId !== 'number') {
      toast.error('ผู้ใช้ role user ต้องเลือกทีม')
      return
    }
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
              onChange={(event) => {
                const nextRole = event.target.value as UserRole
                setRole(nextRole)
                if (nextRole === 'admin') setTeamId(null)
                else if (teamId === null) setTeamId(teams[0]?.id ?? null)
              }}
              autoFocus
            >
              {roles.map((roleOption) => (
                <option key={roleOption} value={roleOption}>
                  {roleOption}
                </option>
              ))}
            </select>
            {role === 'user' ? (
              <TeamSelect id={`team-${user.id}`} teams={teams} value={teamId} onChange={setTeamId} />
            ) : null}
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
              className="w-full sm:w-auto"
              disabled={roleMutation.isPending || (role === user.role && (role === 'admin' || teamId === user.teamId))}
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
            <div className="rounded-full bg-[color:var(--color-danger-soft)] p-2">
              <AlertTriangle className="h-6 w-6 text-danger" />
            </div>
            <DialogTitle>ยืนยันการลบผู้ใช้</DialogTitle>
          </div>
          <DialogDescription className="pt-2">
            คุณแน่ใจหรือไม่ที่จะลบ <strong className="text-foreground">{user.username}</strong>?
            <br />
            <span className="text-danger">การกระทำนี้ไม่สามารถย้อนกลับได้</span>
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
            className="w-full sm:w-auto"
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
