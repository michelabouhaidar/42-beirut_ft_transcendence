import { useCallback, useEffect, useState } from "react";
import { Pencil, Ban, RotateCcw, Trash2, ShieldCheck } from "lucide-react";
import { authApi, AdminUserDetail } from "../api/auth";
import { Alert, Avatar, Button, EmptyState, ErrorPage, LoadError, Loading } from "../components";
import { useApp } from "../context/AppContext";
import { AppLayout, Trail } from "./AppLayout";
import { UserActionDialogs, UserActionRequest, UserAction } from "./admin/UserActionDialogs";
import { AccountStatusBadge, DefinitionList, RoleBadge, SectionHeading, blockedReason } from "./admin/adminUi";
import { formatDate, formatRelative } from "../lib/format";

export function AdminUserDetailPage({ userId }: { userId: string }) {
  const { navigate } = useApp();
  const [user, setUser] = useState<AdminUserDetail | null>(null);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const [actionRequest, setActionRequest] = useState<UserActionRequest | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await authApi.adminGetUser(userId);
      setUser(res.user);
      setError(null);
    } catch (err) {
      const e = err as Error & { code?: string };
      setError({ code: e.code, message: e.message });
    }
  }, [userId]);

  useEffect(() => {
    setUser(null);
    load();
  }, [load]);

  if (error?.code === "NOT_FOUND") {
    return (
      <ErrorPage
        code="404"
        title="User not found"
        message="This account doesn't exist. It may have been removed from the list, or the link is wrong."
        home="/admin/users"
      />
    );
  }

  const open = (action: UserAction) => user && setActionRequest({ action, userId: user.id });
  const isDeleted = user?.status === "DELETED";
  const suspendBlocked = user ? blockedReason(user, "suspend") : null;
  const deleteBlocked = user ? blockedReason(user, "delete") : null;
  const guardNotice = user && !isDeleted && !user.guards.isSelf ? suspendBlocked : null;

  return (
    <AppLayout variant="admin" trail={<Trail items={[{ label: "Admin" }, { label: "Users", path: "/admin/users" }, { label: user?.fullName ?? "User" }]} />}>
      {!user ? (
        error ? (
          <LoadError what="this user" message={error.message} onRetry={load} />
        ) : (
          <Loading label="Loading user" />
        )
      ) : (
        <>
          {/* Identity + actions */}
          <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-6 pb-6 mb-6 border-b border-zinc-200 dark:border-dark-border">
            <div className="flex items-start gap-4 min-w-0">
              <Avatar size="xl" name={user.fullName} src={user.avatarPath || undefined} colorSeed={user.id} className={isDeleted ? "opacity-50" : ""} />
              <div className="min-w-0">
                <h1 className="text-2xl font-bold tracking-tight text-zinc-950 dark:text-white break-words">
                  {user.fullName}
                  {user.guards.isSelf && <span className="ml-2 text-base font-normal text-zinc-400">(you)</span>}
                </h1>
                <p className="text-sm text-zinc-500 dark:text-zinc-400 break-all">{user.email}</p>
                <div className="flex flex-wrap items-center gap-2 mt-3">
                  <AccountStatusBadge status={user.status} />
                  {user.role === "SA" && <RoleBadge role="SA" />}
                  {user.organization && user.orgRole && (
                    <>
                      <RoleBadge role={user.orgRole} />
                      <span className="text-sm text-zinc-600 dark:text-zinc-300">in {user.organization.name}</span>
                    </>
                  )}
                </div>
              </div>
            </div>

            {!isDeleted && (
              <div className="flex flex-wrap gap-2 shrink-0">
                <Button variant="outline" onClick={() => open("edit")} leftIcon={<Pencil className="w-4 h-4" />}>
                  Edit
                </Button>
                {user.status === "SUSPENDED" ? (
                  <Button variant="outline" onClick={() => open("reactivate")} leftIcon={<RotateCcw className="w-4 h-4" />}>
                    Reactivate
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    onClick={() => open("suspend")}
                    disabled={Boolean(suspendBlocked)}
                    title={suspendBlocked ?? undefined}
                    leftIcon={<Ban className="w-4 h-4" />}
                  >
                    Suspend
                  </Button>
                )}
                <Button
                  variant="outline"
                  onClick={() => open("delete")}
                  disabled={Boolean(deleteBlocked)}
                  title={deleteBlocked ?? undefined}
                  className="text-destructive-700 dark:text-destructive-400 hover:border-destructive-400"
                  leftIcon={<Trash2 className="w-4 h-4" />}
                >
                  Delete
                </Button>
              </div>
            )}
          </div>

          {guardNotice && (
            <Alert variant="info" title="Protected account" className="mb-6">
              {guardNotice} Until then this account can't be suspended, deleted or demoted.
            </Alert>
          )}
          {isDeleted && (
            <Alert variant="info" title="Deleted account" className="mb-6">
              Personal data was erased and can't be restored. Tasks and comments this person wrote remain, shown as “Deleted user”.
            </Alert>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] gap-x-10 gap-y-8">
            <div className="space-y-8 min-w-0">
              <section>
                <SectionHeading>Account</SectionHeading>
                <DefinitionList
                  rows={[
                    { label: "Job title", value: user.jobTitle || <span className="text-zinc-400">Not set</span> },
                    {
                      label: "Two-factor",
                      value: user.twoFactorEnabled ? (
                        <span className="inline-flex items-center gap-1.5 text-success-700 dark:text-success-400">
                          <ShieldCheck className="w-4 h-4" aria-hidden="true" /> On
                        </span>
                      ) : (
                        "Off"
                      ),
                    },
                    {
                      label: "Last login",
                      value: (
                        <span title={formatDate(user.lastLoginAt, true)}>
                          {formatRelative(user.lastLoginAt)}
                          {user.lastLoginAt && (
                            <span className="text-zinc-400 dark:text-zinc-500"> ({formatDate(user.lastLoginAt, true)})</span>
                          )}
                        </span>
                      ),
                    },
                    { label: "Signed up", value: formatDate(user.createdAt) },
                    { label: "Account ID", value: <code className="text-xs text-zinc-500 dark:text-zinc-400">{user.id}</code> },
                  ]}
                />
              </section>

              <section>
                <SectionHeading>Bio</SectionHeading>
                {user.bio ? (
                  <p className="text-sm leading-relaxed text-zinc-700 dark:text-zinc-300 max-w-prose whitespace-pre-line">{user.bio}</p>
                ) : (
                  <p className="text-sm text-zinc-400 dark:text-zinc-500">No bio.</p>
                )}
              </section>
            </div>

            <div className="space-y-8 min-w-0">
              <section>
                <SectionHeading>Work</SectionHeading>
                <div className="grid grid-cols-2 gap-px bg-zinc-200 dark:bg-dark-border border border-zinc-200 dark:border-dark-border">
                  <Stat value={user.counts.tasksAssigned} label="Assigned tasks" />
                  <Stat value={user.counts.tasksCreated} label="Tasks created" />
                  <Stat value={user.counts.comments} label="Comments" />
                  <Stat value={user.counts.friendships} label="Friends" />
                </div>
              </section>

              <section>
                <SectionHeading aside={user.memberships.length > 0 ? `${user.memberships.length} total` : undefined}>
                  Organization history
                </SectionHeading>
                {user.memberships.length === 0 ? (
                  <EmptyState
                    title="No organizations"
                    description={
                      user.isSystemAdmin
                        ? "System Admins don't belong to an organization."
                        : "This person hasn't joined an organization yet."
                    }
                    className="p-6 sm:p-6"
                  />
                ) : (
                  <ol className="border border-zinc-200 dark:border-dark-border divide-y divide-zinc-200 dark:divide-dark-border">
                    {user.memberships.map((m) => {
                      const current = m.status === "ACTIVE" && !m.orgDeleted;
                      return (
                        <li key={m.id} className="px-4 py-3 flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            {m.orgDeleted ? (
                              <span className="font-semibold text-zinc-500 dark:text-zinc-400 line-through">{m.orgName}</span>
                            ) : (
                              <Button variant="link" onClick={() => navigate(`/admin/orgs/${m.orgId}`)}>
                                {m.orgName}
                              </Button>
                            )}
                            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5 tabular-nums">
                              {formatDate(m.joinedAt)} to {current ? "now" : m.leftAt ? formatDate(m.leftAt) : "deletion"}
                            </p>
                          </div>
                          {current ? <RoleBadge role={m.role} /> : <span className="text-xs text-zinc-400">Ended</span>}
                        </li>
                      );
                    })}
                  </ol>
                )}
              </section>
            </div>
          </div>
        </>
      )}

      <UserActionDialogs
        request={actionRequest}
        onClose={() => setActionRequest(null)}
        onDone={() => {
          setActionRequest(null);
          load();
        }}
      />
    </AppLayout>
  );
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div className="px-4 py-3 bg-white dark:bg-dark-card">
      <div className="text-xl font-bold tabular-nums text-zinc-900 dark:text-white">{value}</div>
      <div className="text-xs text-zinc-500 dark:text-zinc-400">{label}</div>
    </div>
  );
}