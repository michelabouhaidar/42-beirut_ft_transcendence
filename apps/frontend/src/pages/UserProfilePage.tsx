import { ReactNode, useCallback, useEffect, useState } from "react";
import { ArrowLeft, Building2, CalendarDays, Briefcase, UserCheck, Users } from "lucide-react";
import type { ApiError } from "../api/http";
import { usersApi, UserProfileResponse, PresenceUpdate, ProfileTask } from "../api/users";
import { useOnReconnect, useSocketEvent } from "../context/RealtimeContext";
import { useAuth } from "../context/AuthContext";
import { Alert, Avatar, Badge, Button, Card, Loading, UserRoleBadge } from "../components";
import { AppLayout } from "./AppLayout";
import { useApp } from "../context/AppContext";
import { FriendButton } from "./workspace/FriendButton";
import { DueDate, PriorityBadge, StatusBadge } from "./projects/taskUi";
import { formatDate, formatRelative } from "../lib/format";

const longDate = (value: string) => formatDate(value, false, "long");

function lastSeenLabel(iso: string | null): string {
  if (!iso) return "Offline";
  const mins = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 60) return `Last seen ${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `Last seen ${hours} h ago`;
  return `Last seen ${longDate(iso)}`;
}

// /users/:id
export function UserProfilePage({ userId }: { userId: string }) {
  const { user: me } = useAuth();
  const { navigate } = useApp();
  const [data, setData] = useState<UserProfileResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setData(await usersApi.getProfile(userId));
      setError(null);
    } catch (err) {
      const e = err as ApiError;
      setError(e.code === "NOT_FOUND" ? "This person doesn't exist or isn't in your organization." : e.message);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  useSocketEvent<PresenceUpdate>("presence:update", (p) => {
    if (p.userId !== userId) return;
    setData((d) => (d && d.presence ? { ...d, presence: { status: p.status, lastSeenAt: p.lastSeenAt } } : d));
  });
  // The friend button follows requests and answers made elsewhere.
  useSocketEvent("friendship:updated", load);
  useOnReconnect(load);
  // Work numbers change elsewhere; refresh when coming back to the tab.
  useEffect(() => {
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, [load]);

  // Own profile: reflect edits made in the account modal right away.
  const profile = data && data.isSelf && me ? { ...data.user, ...me } : data?.user;
  const name = profile ? `${profile.firstName} ${profile.lastName}` : "";

  return (
    <AppLayout>
      <div>
        <Button
          variant="ghost"
          size="sm"
          leftIcon={<ArrowLeft className="w-3.5 h-3.5" />}
          onClick={() => (window.history.length > 1 ? window.history.back() : navigate("/org/members"))}
        >
          Back
        </Button>
      </div>

      {loading && <Loading label="Loading profile" className="py-16" />}
      {!loading && error && <Alert variant="error">{error}</Alert>}

      {!loading && data && profile && (
        <div className="grid grid-cols-1 lg:grid-cols-[22rem_minmax(0,1fr)] gap-6 items-start">
          {/* Identity */}
          <Card padding="lg" className="lg:sticky lg:top-20">
            <div className="flex flex-col items-center text-center gap-3">
              <Avatar
                size="xl"
                name={name}
                src={profile.avatarPath || undefined}
                colorSeed={profile.id}
                status={data.presence ? data.presence.status : undefined}
              />
              <div className="space-y-1.5">
                <h1 className="text-xl font-bold tracking-tight text-zinc-950 dark:text-white break-words">{name}</h1>
                <div className="flex flex-wrap justify-center items-center gap-1.5">
                  {profile.role && <UserRoleBadge role={profile.role} />}
                  {data.isSelf && <Badge variant="primary">You</Badge>}
                  {data.friendship.state === "FRIENDS" && <Badge variant="active" size="sm">Friend</Badge>}
                </div>
                {profile.jobTitle && (
                  <div className="text-sm text-zinc-600 dark:text-zinc-300 flex items-center justify-center gap-1.5">
                    <Briefcase className="w-3.5 h-3.5 text-zinc-400" /> {profile.jobTitle}
                  </div>
                )}
                {data.presence && (
                  <div className={`text-xs ${data.presence.status === "online" ? "text-success-600 dark:text-success-400 font-medium" : "text-zinc-500 dark:text-zinc-400"}`}>
                    {data.presence.status === "online" ? "Online now" : lastSeenLabel(data.presence.lastSeenAt)}
                  </div>
                )}
              </div>
              {!data.isSelf && (data.canRequestFriend || data.friendship.state !== "NONE") && (
                <FriendButton size="md" userId={profile.id} name={name} state={data.friendship.state} friendshipId={data.friendship.id} onChanged={load} />
              )}
            </div>

            {profile.bio && (
              <div className="mt-6 pt-5 border-t border-zinc-200 dark:border-dark-border">
                <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400 mb-2">About</h2>
                <p className="text-sm text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap break-words">{profile.bio}</p>
              </div>
            )}

            <dl className="mt-6 pt-5 border-t border-zinc-200 dark:border-dark-border space-y-2.5 text-sm">
              <InfoRow icon={<Building2 className="w-4 h-4" />} label="Organization" value={profile.organization?.name ?? "No organization"} />
              <InfoRow icon={<CalendarDays className="w-4 h-4" />} label="Member since" value={longDate(data.user.memberSince)} />
              {data.friendsSince && <InfoRow icon={<UserCheck className="w-4 h-4" />} label="Friends since" value={longDate(data.friendsSince)} />}
              {data.work && <InfoRow icon={<Users className="w-4 h-4" />} label="Friends" value={String(data.work.friendCount)} />}
            </dl>
          </Card>

          {/* Work and people */}
          {data.work ? (
            <div className="space-y-6 min-w-0">
              <div className="grid grid-cols-3 gap-3">
                <Stat label="Open tasks" value={data.work.stats.open} />
                <Stat label="Overdue" value={data.work.stats.overdue} tone={data.work.stats.overdue > 0 ? "danger" : undefined} />
                <Stat label="Done (30 days)" value={data.work.stats.doneLast30Days} tone="success" />
              </div>

              <Card padding="none">
                <SectionTitle>{data.isSelf ? "Assigned to you" : `Assigned to ${profile.firstName}`}</SectionTitle>
                {data.work.openTasks.length === 0 ? (
                  <p className="px-5 py-6 text-sm text-zinc-500 dark:text-zinc-400">No open tasks in projects you can see.</p>
                ) : (
                  <TaskRows tasks={data.work.openTasks} />
                )}
              </Card>

              {data.work.recentlyCompleted.length > 0 && (
                <Card padding="none">
                  <SectionTitle>Recently completed</SectionTitle>
                  <TaskRows tasks={data.work.recentlyCompleted} completed />
                </Card>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <Card padding="none">
                  <SectionTitle>Projects</SectionTitle>
                  {data.work.projects.length === 0 ? (
                    <p className="px-5 py-6 text-sm text-zinc-500 dark:text-zinc-400">No projects you share.</p>
                  ) : (
                    <ul className="divide-y divide-zinc-100 dark:divide-dark-border">
                      {data.work.projects.map((p) => (
                        <li key={p.key}>
                          <button
                            type="button"
                            onClick={() => navigate(`/projects/${p.key}/board`)}
                            className="w-full px-5 py-3 flex items-center gap-3 text-left hover:bg-zinc-50 dark:hover:bg-dark-elevated cursor-pointer"
                          >
                            <code className="text-xs font-semibold text-brand-700 dark:text-brand-300 bg-brand-50 dark:bg-brand-950/40 border border-brand-200/60 dark:border-brand-800/60 px-1.5 py-0.5 shrink-0">
                              {p.key}
                            </code>
                            <span className="flex-1 min-w-0 truncate text-sm text-zinc-900 dark:text-white">{p.name}</span>
                            <span className="text-xs text-zinc-500 dark:text-zinc-400 tabular-nums">{p.openAssigned} open</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>

                <Card padding="none">
                  <SectionTitle>{data.isSelf ? "Your friends here" : "Mutual friends"}</SectionTitle>
                  {data.work.mutualFriends.length === 0 ? (
                    <p className="px-5 py-6 text-sm text-zinc-500 dark:text-zinc-400">{data.isSelf ? "No friends yet." : "No friends in common yet."}</p>
                  ) : (
                    <ul className="divide-y divide-zinc-100 dark:divide-dark-border">
                      {data.work.mutualFriends.map((f) => (
                        <li key={f.id}>
                          <button
                            type="button"
                            onClick={() => navigate(`/users/${f.id}`)}
                            className="w-full px-5 py-3 flex items-center gap-3 text-left hover:bg-zinc-50 dark:hover:bg-dark-elevated cursor-pointer"
                          >
                            <Avatar size="sm" name={f.name} src={f.avatarPath || undefined} colorSeed={f.id} />
                            <span className="text-sm text-zinc-900 dark:text-white truncate">{f.name}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
              </div>
            </div>
          ) : (
            <Card padding="lg">
              <p className="text-sm text-zinc-500 dark:text-zinc-400">Work details are shown for people in your organization.</p>
            </Card>
          )}
        </div>
      )}
    </AppLayout>
  );
}

function InfoRow({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="text-zinc-400 shrink-0">{icon}</span>
      <dt className="text-zinc-500 dark:text-zinc-400">{label}</dt>
      <dd className="ml-auto text-zinc-900 dark:text-zinc-100 text-right truncate">{value}</dd>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "danger" | "success" }) {
  const color =
    tone === "danger" ? "text-destructive-600 dark:text-destructive-400" : tone === "success" ? "text-success-600 dark:text-success-400" : "text-zinc-950 dark:text-white";
  return (
    <Card padding="md">
      <div className={`text-2xl font-bold tabular-nums ${color}`}>{value}</div>
      <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">{label}</div>
    </Card>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <h2 className="px-5 py-3 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400 border-b border-zinc-100 dark:border-dark-border">
      {children}
    </h2>
  );
}

// Clicking a task opens it in its project.
function TaskRows({ tasks, completed = false }: { tasks: ProfileTask[]; completed?: boolean }) {
  const { navigate } = useApp();
  return (
    <ul className="divide-y divide-zinc-100 dark:divide-dark-border">
      {tasks.map((t) => (
        <li key={t.key}>
          <button
            type="button"
            onClick={() => navigate(`/projects/${t.projectKey}/tasks/${t.number}`)}
            className="w-full px-5 py-3 flex flex-wrap sm:flex-nowrap items-center gap-x-3 gap-y-1.5 text-left hover:bg-zinc-50 dark:hover:bg-dark-elevated cursor-pointer"
          >
            <span className="font-mono text-xs font-semibold text-zinc-500 dark:text-zinc-400 w-20 shrink-0">{t.key}</span>
            <span className="flex-1 min-w-0">
              <span className="block truncate text-sm font-medium text-zinc-900 dark:text-white">{t.title}</span>
              <span className="block truncate text-xs text-zinc-500 dark:text-zinc-400">{t.projectName}</span>
            </span>
            {completed ? (
              <span className="text-xs text-zinc-500 dark:text-zinc-400">{t.completedAt ? `Done ${formatRelative(t.completedAt)}` : "Done"}</span>
            ) : (
              <span className="flex items-center gap-2 shrink-0 basis-full sm:basis-auto pl-[5.75rem] sm:pl-0">
                <StatusBadge status={t.status} />
                <PriorityBadge priority={t.priority} />
                <DueDate task={t} />
              </span>
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}
