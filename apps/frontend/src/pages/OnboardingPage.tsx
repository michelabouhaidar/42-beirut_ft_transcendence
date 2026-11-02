import { ReactNode, useEffect, useMemo, useState } from "react";
import { Building2, Clock, Inbox, MailCheck, Plus, Search, UserPlus } from "lucide-react";
import { authApi, Invitation, Organization, OrgPendingInvitation, WorkspaceMember } from "../api/auth";
import { Project, projectsApi } from "../api/projects";
import { useAuth } from "../context/AuthContext";
import { useApp } from "../context/AppContext";
import { useOnReconnect, useSocketEvent, useSocketEvents } from "../context/RealtimeContext";
import {
  Alert,
  Avatar,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  ConfirmDialog,
  EmptyState,
  Input,
  Spinner,
  Tabs,
  Textarea,
  UserRoleBadge,
} from "../components";
import { useAsync } from "../lib/hooks";
import { formatDate, formatDay } from "../lib/format";
import { AppLayout } from "./AppLayout";
import { InviteDialog } from "./workspace/InviteDialog";
import { ProjectFormDialog, ProjectProgress } from "./projects/projectUi";

type Feedback = { type: "success" | "error"; message: string } | null;

function FeedbackAlert({ feedback, onClose }: { feedback: Feedback; onClose: () => void }) {
  if (!feedback) return null;
  return (
    <Alert variant={feedback.type} onClose={onClose}>
      {feedback.message}
    </Alert>
  );
}

// /onboarding, /projects and the other workspace homes: getting started for unaffiliated users, projects and team for everyone else.
export function OnboardingPage() {
  const { organization, role, isSA } = useAuth();
  const isWorkingUser = Boolean((organization && role && role !== "U") || isSA);
  return isWorkingUser ? <WorkspaceHome /> : <GettingStarted />;
}

// ---------- Unaffiliated: create an organization or accept an invitation ----------

function IconTitle({ icon, title, description }: { icon: ReactNode; title: string; description: string }) {
  return (
    <CardHeader>
      <div className="flex items-center gap-3">
        <div className="h-10 w-10 flex items-center justify-center rounded-none bg-brand-50 dark:bg-brand-950/30 text-brand-600 border border-brand-200 dark:border-brand-900/60 shrink-0">
          {icon}
        </div>
        <div>
          <CardTitle>{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </div>
      </div>
    </CardHeader>
  );
}

function GettingStarted() {
  const { user, setAuthData } = useAuth();
  const [orgName, setOrgName] = useState("");
  const [orgDescription, setOrgDescription] = useState("");
  const create = useAsync();
  const [invitations, setInvitations] = useState<Invitation[] | null>(null);
  const [actioningId, setActioningId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);

  // Again when an invitation arrives or is revoked.
  const [version, setVersion] = useState(0);
  useSocketEvent("notification:new", () => setVersion((v) => v + 1));
  useEffect(() => {
    let live = true;
    authApi
      .getInvitations()
      .then((data) => live && setInvitations(data.invitations || []))
      .catch(() => {
        if (live) setInvitations((i) => i ?? []);
      });
    return () => {
      live = false;
    };
  }, [version]);

  const handleCreateOrg = async (e: { preventDefault: () => void }) => {
    e.preventDefault();
    if (orgName.trim().length < 2) return create.setError("Organization name must be at least 2 characters.");
    const res = await create.run(() => authApi.createOrganization({ name: orgName.trim(), description: orgDescription.trim() || undefined }));
    if (res && user) {
      setAuthData(user, res.organization, "OA");
      setFeedback({ type: "success", message: `Workspace "${res.organization.name}" created successfully!` });
    }
  };

  const respond = async (inv: Invitation, accept: boolean) => {
    setActioningId(inv.id);
    setFeedback(null);
    try {
      if (accept) {
        const res = await authApi.acceptInvitation(inv.id);
        if (user) setAuthData(user, res.organization, res.role);
        setFeedback({ type: "success", message: res.message || `Joined ${inv.organization.name}!` });
      } else {
        await authApi.declineInvitation(inv.id);
        setInvitations((prev) => (prev ?? []).filter((i) => i.id !== inv.id));
        setFeedback({ type: "success", message: "Invitation declined." });
      }
    } catch (err) {
      setFeedback({ type: "error", message: (err as Error).message || `Failed to ${accept ? "accept" : "decline"} invitation.` });
    } finally {
      setActioningId(null);
    }
  };

  return (
    <AppLayout variant="plain">
      <FeedbackAlert feedback={feedback} onClose={() => setFeedback(null)} />

      <div className="text-center max-w-xl mx-auto space-y-2 pt-4">
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-zinc-950 dark:text-white font-sans">Welcome to Trenno</h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400 font-sans">To get started, create a new workspace or accept an invitation to an existing team.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-8 items-start">
        <Card>
          <IconTitle icon={<Building2 className="h-5 w-5" />} title="Create an Organization" description="Establish a new workspace as an Organization Administrator" />
          <CardContent className="pt-4">
            <form onSubmit={handleCreateOrg} className="space-y-4">
              {create.error && <Alert variant="error">{create.error}</Alert>}
              <Input
                label="Workspace / Organization Name"
                value={orgName}
                onChange={(e) => setOrgName(e.target.value)}
                placeholder="e.g. 42 Beirut"
                required
                maxLength={100}
                disabled={create.busy}
              />
              <Textarea
                label="Description (Optional)"
                value={orgDescription}
                onChange={(e) => setOrgDescription(e.target.value)}
                placeholder="Brief summary of your team's work..."
                rows={3}
                maxLength={1000}
                disabled={create.busy}
              />
              <Button type="submit" fullWidth isLoading={create.busy}>
                Create Workspace
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <IconTitle icon={<MailCheck className="h-5 w-5" />} title="Pending Invitations" description="Join teams that have invited your email address" />
          <CardContent className="pt-4">
            {!invitations ? (
              <div className="py-12 text-center text-xs text-zinc-500 dark:text-zinc-400 font-sans">
                <Spinner size="lg" className="mx-auto mb-2" label="Checking invitations" />
                Checking invitations for {user?.email}...
              </div>
            ) : invitations.length > 0 ? (
              <div className="space-y-3">
                {invitations.map((inv) => (
                  <div key={inv.id} className="p-4 border border-zinc-200/90 dark:border-zinc-800/90 bg-zinc-50 dark:bg-dark-card flex flex-col gap-3">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="font-semibold text-sm text-zinc-950 dark:text-white font-sans">{inv.organization.name}</div>
                        {inv.organization.description && (
                          <div className="text-xs text-zinc-500 dark:text-zinc-400 line-clamp-1 font-sans mt-0.5">{inv.organization.description}</div>
                        )}
                        <div className="text-[11px] text-zinc-400 mt-1 font-sans">
                          Invited by {inv.invitedBy.firstName} {inv.invitedBy.lastName}
                        </div>
                      </div>
                      <Badge variant={inv.role === "OA" ? "oa" : "member"}>{inv.role}</Badge>
                    </div>
                    <div className="flex items-center gap-2 pt-2 border-t border-zinc-200 dark:border-dark-border">
                      <Button size="sm" fullWidth isLoading={actioningId === inv.id} disabled={actioningId !== null} onClick={() => respond(inv, true)}>
                        Accept
                      </Button>
                      <Button variant="outline" size="sm" fullWidth disabled={actioningId !== null} onClick={() => respond(inv, false)}>
                        Decline
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState
                icon={<Inbox className="h-6 w-6 text-zinc-400" />}
                title="No Invitations Found"
                description={`No pending team invitations found for ${user?.email || "your account"}.`}
              />
            )}
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
}

// ---------- Working users: projects and team ----------

function SectionHeader({ title, subtitle, action, as: Heading }: { title: string; subtitle: string; action?: ReactNode; as: "h1" | "h2" }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
      <div>
        <Heading className="text-xl sm:text-2xl font-bold tracking-tight text-zinc-950 dark:text-white font-sans">{title}</Heading>
        <p className="text-xs sm:text-sm text-zinc-500 dark:text-zinc-400 font-sans">{subtitle}</p>
      </div>
      {action}
    </div>
  );
}

const rowClass = "p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:bg-zinc-50 dark:hover:bg-dark-elevated transition-colors";

function WorkspaceHome() {
  const { user, organization, role } = useAuth();
  const { navigate } = useApp();
  const [orgDetails, setOrgDetails] = useState<Organization | null>(null);
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [pendingInvitations, setPendingInvitations] = useState<OrgPendingInvitation[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [projectSearch, setProjectSearch] = useState("");
  const [projectFilter, setProjectFilter] = useState<"all" | "active">("all");
  const [teamTab, setTeamTab] = useState<"members" | "invitations">("members");
  const [memberSearch, setMemberSearch] = useState("");
  const [revokeTarget, setRevokeTarget] = useState<OrgPendingInvitation | null>(null);
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);

  const canManage = role === "OA" || role === "SA";
  const activeOrg = orgDetails || organization;

  const load = async () => {
    setIsLoading(true);
    try {
      // Members and Viewers only get the projects they have access to.
      const [data, projectList] = await Promise.all([authApi.getCurrentOrg(), projectsApi.list()]);
      if (data.organization) setOrgDetails(data.organization);
      if (data.members) setMembers(data.members);
      setProjects(projectList.projects);
      if (data.pendingInvitations) setPendingInvitations(data.pendingInvitations);
    } catch {
      // The page shows what loaded; the next live event or reload retries.
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [organization?.id]);

  // projects and members change under other people's hands; my own access too (me:updated).
  useSocketEvents(["project:created", "project:updated", "project:deleted", "member:updated", "me:updated"], () => load());
  useOnReconnect(() => load());

  const revoke = async () => {
    if (!revokeTarget) return;
    try {
      const res = await authApi.revokeInvitation(revokeTarget.id);
      setPendingInvitations((prev) => prev.filter((i) => i.id !== revokeTarget.id));
      setFeedback({ type: "success", message: res.message });
    } catch (err) {
      setFeedback({ type: "error", message: (err as Error).message || "Failed to revoke invitation." });
      throw err;
    }
  };

  const filteredProjects = useMemo(() => {
    const q = projectSearch.toLowerCase();
    return projects.filter((p) => [p.name, p.key, p.description ?? ""].some((v) => v.toLowerCase().includes(q)) && (projectFilter === "all" || p.openCount > 0));
  }, [projects, projectSearch, projectFilter]);

  const filteredMembers = useMemo(() => {
    const q = memberSearch.toLowerCase();
    return members.filter((m) => [`${m.firstName} ${m.lastName}`, m.email, m.jobTitle ?? ""].some((v) => v.toLowerCase().includes(q)));
  }, [members, memberSearch]);

  const openProject = (key: string) => navigate(`/projects/${key}/board`);

  return (
    <AppLayout>
      <FeedbackAlert feedback={feedback} onClose={() => setFeedback(null)} />

      {/* Projects */}
      <div className="space-y-4">
        <SectionHeader
          as="h1"
          title="Projects"
          subtitle="Manage projects, agile Kanban boards, and issues"
          action={
            canManage && (
              <Button size="sm" onClick={() => setCreateProjectOpen(true)} leftIcon={<Plus className="w-3.5 h-3.5" />}>
                New Project
              </Button>
            )
          }
        />

        {projects.length > 0 && (
          <Card padding="sm" className="flex items-center justify-between gap-3">
            <div className="flex-1 max-w-sm">
              <Input
                type="search"
                inputSize="sm"
                aria-label="Filter projects"
                placeholder="Filter projects by key or name..."
                value={projectSearch}
                onChange={(e) => setProjectSearch(e.target.value)}
                leftIcon={<Search className="w-4 h-4" />}
              />
            </div>
            <Tabs
              variant="segmented"
              size="sm"
              activeTab={projectFilter}
              onChange={(id) => setProjectFilter(id as typeof projectFilter)}
              tabs={[
                { id: "all", label: "All", count: projects.length },
                { id: "active", label: "Active" },
              ]}
            />
          </Card>
        )}

        {isLoading ? (
          <Card padding="none" className="py-16 text-center text-xs text-zinc-500 dark:text-zinc-400">
            <Spinner size="xl" className="mx-auto mb-3" label="Loading projects" />
            Loading workspace projects...
          </Card>
        ) : filteredProjects.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {filteredProjects.map((proj) => (
              <Card
                key={proj.id}
                variant="interactive"
                role="link"
                tabIndex={0}
                aria-label={`Open ${proj.name}`}
                onClick={() => openProject(proj.key)}
                onKeyDown={(e) => e.key === "Enter" && openProject(proj.key)}
                className="flex flex-col justify-between group hover:border-brand-500/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
              >
                <CardHeader>
                  <div className="w-full flex items-center justify-between gap-3">
                    <code className="text-xs font-semibold text-brand-700 dark:text-brand-300 bg-brand-50 dark:bg-brand-950/40 border border-brand-200/60 dark:border-brand-800/60 px-1.5 py-0.5">
                      {proj.key}
                    </code>
                    {proj.targetDate && <span className="text-[11px] text-zinc-500 dark:text-zinc-400">Target {formatDay(proj.targetDate)}</span>}
                  </div>
                  <CardTitle className="mt-3 text-base sm:text-lg font-semibold text-zinc-900 dark:text-white group-hover:text-brand-500 transition-colors">{proj.name}</CardTitle>
                  {proj.description && <CardDescription className="line-clamp-2 mt-1">{proj.description}</CardDescription>}
                </CardHeader>
                <ProjectProgress project={proj} className="mt-4" />
              </Card>
            ))}
          </div>
        ) : projects.length > 0 ? (
          <EmptyState
            icon={<Search className="h-7 w-7 text-zinc-400" />}
            title="No Matching Projects"
            description={`No sprint projects matched your search "${projectSearch}".`}
            action={{
              label: "Clear Filter",
              onClick: () => {
                setProjectSearch("");
                setProjectFilter("all");
              },
            }}
          />
        ) : (
          <EmptyState
            title={canManage ? "No Projects Created Yet" : "No projects yet"}
            description={canManage ? "Create your first project to organize backlog tasks and track deliverables." : "Projects appear here once an Org Admin gives you access."}
            action={canManage ? { label: "Create Project", onClick: () => setCreateProjectOpen(true), icon: <Plus className="w-3.5 h-3.5" /> } : undefined}
          />
        )}
      </div>

      {/* Team and access */}
      <div className="space-y-4">
        <SectionHeader
          as="h2"
          title="Workspace Team & Access Control"
          subtitle="Active team members, roles, and pending organization invitations"
          action={
            canManage && (
              <Button variant="outline" size="sm" onClick={() => setInviteOpen(true)} leftIcon={<UserPlus className="w-3.5 h-3.5" />}>
                Invite Colleague
              </Button>
            )
          }
        />

        <Card padding="none">
          <div className="flex items-center justify-between border-b border-zinc-200 dark:border-zinc-800 px-4 py-3 bg-zinc-50/50 dark:bg-dark-elevated/40">
            <Tabs
              variant="segmented"
              size="sm"
              activeTab={teamTab}
              onChange={(id) => setTeamTab(id as typeof teamTab)}
              tabs={[
                { id: "members", label: "Active Members", count: members.length },
                ...(canManage ? [{ id: "invitations", label: "Pending Invitations", count: pendingInvitations.length }] : []),
              ]}
            />
            {teamTab === "members" && (
              <div className="hidden sm:block w-60">
                <Input
                  type="search"
                  inputSize="sm"
                  aria-label="Search members"
                  placeholder="Search members..."
                  value={memberSearch}
                  onChange={(e) => setMemberSearch(e.target.value)}
                  leftIcon={<Search className="w-3.5 h-3.5" />}
                />
              </div>
            )}
          </div>

          <div className="divide-y divide-zinc-100 dark:divide-zinc-800/80">
            {teamTab === "members" ? (
              filteredMembers.map((m) => (
                <div key={m.id} className={rowClass}>
                  <div className="flex items-center gap-3.5">
                    <Avatar size="md" name={`${m.firstName} ${m.lastName}`} src={m.avatarPath || undefined} colorSeed={m.userId} />
                    <div>
                      <div className="font-semibold text-sm text-zinc-950 dark:text-white font-sans flex items-center gap-2">
                        <span>
                          {m.firstName} {m.lastName}
                        </span>
                        {m.userId === user?.id && <Badge variant="primary">You</Badge>}
                      </div>
                      <div className="text-xs text-zinc-500 dark:text-zinc-400 font-sans mt-0.5">
                        {m.email} {m.jobTitle ? `· ${m.jobTitle}` : ""}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-4 text-xs font-sans">
                    <div className="text-zinc-400 text-[11px] hidden md:block">Joined {formatDate(m.joinedAt)}</div>
                    <UserRoleBadge role={m.role} />
                    <Badge variant="active" dot>
                      Active
                    </Badge>
                  </div>
                </div>
              ))
            ) : pendingInvitations.length > 0 ? (
              pendingInvitations.map((inv) => (
                <div key={inv.id} className={rowClass}>
                  <div className="flex items-center gap-3">
                    <div className="h-10 w-10 flex items-center justify-center rounded-none bg-warning-50 dark:bg-warning-950/30 text-warning-600 border border-warning-200 dark:border-warning-900/60 shrink-0">
                      <MailCheck className="h-5 w-5" />
                    </div>
                    <div>
                      <div className="font-semibold text-sm text-zinc-950 dark:text-white font-sans">{inv.email}</div>
                      <div className="text-xs text-zinc-400 font-sans mt-0.5">
                        Sent {formatDate(inv.createdAt)} · Expires {formatDate(inv.expiresAt)}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <Badge variant={inv.role === "OA" ? "oa" : "member"}>{inv.role}</Badge>
                    <Badge variant="pending" icon={<Clock className="w-3 h-3" />}>
                      Pending response
                    </Badge>
                    {canManage && (
                      <Button variant="destructive" size="sm" onClick={() => setRevokeTarget(inv)}>
                        Revoke
                      </Button>
                    )}
                  </div>
                </div>
              ))
            ) : (
              <EmptyState
                icon={<Inbox className="h-7 w-7 text-zinc-400" />}
                title="No Pending Invitations"
                description="All sent invitations have been accepted or no new invitations are outstanding."
                action={canManage ? { label: "Send New Invite", onClick: () => setInviteOpen(true) } : undefined}
              />
            )}
          </div>
        </Card>
      </div>

      {/* Create Project */}
      <ProjectFormDialog
        isOpen={createProjectOpen}
        onClose={() => setCreateProjectOpen(false)}
        onSaved={(project) => {
          setProjects((prev) => [project, ...prev]);
          setCreateProjectOpen(false);
        }}
      />

      {activeOrg && (
        <InviteDialog isOpen={inviteOpen} onClose={() => setInviteOpen(false)} orgId={activeOrg.id} orgName={activeOrg.name} canInviteOrgAdmin={false} onInvited={load} />
      )}

      <ConfirmDialog
        isOpen={Boolean(revokeTarget)}
        onClose={() => setRevokeTarget(null)}
        onConfirm={revoke}
        title="Revoke invitation"
        description={`The link sent to ${revokeTarget?.email ?? ""} will stop working. You can invite them again later.`}
        confirmLabel="Revoke invitation"
      />
    </AppLayout>
  );
}