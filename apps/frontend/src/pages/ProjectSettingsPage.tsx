import { useCallback, useEffect, useMemo, useState } from "react";
import { Pencil, ShieldCheck, Trash2, Users } from "lucide-react";
import { Project, ProjectAccessMember, ProjectApiError, projectsApi } from "../api/projects";
import { Avatar, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, ConfirmDialog, EmptyState, ErrorPage, LoadError, Loading, useToast } from "../components";
import { AppLayout } from "./AppLayout";
import { useApp } from "../context/AppContext";
import { useOnReconnect, useSocketEvents } from "../context/RealtimeContext";
import { ConsequenceList, Consequence, DefinitionList, RoleBadge } from "./admin/adminUi";
import { DeleteProjectDialog, ProjectFormDialog } from "./projects/projectUi";
import { formatDate, formatDay, plural } from "../lib/format";

// /projects/:key/settings (Org Admin): details, access, delete.
export function ProjectSettingsPage({ projectKey }: { projectKey: string }) {
  const toast = useToast();
  const { navigate } = useApp();
  const [project, setProject] = useState<Project | null>(null);
  const [members, setMembers] = useState<ProjectAccessMember[] | null>(null);
  const [error, setError] = useState<ProjectApiError | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<ProjectAccessMember | null>(null);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [p, a] = await Promise.all([projectsApi.get(projectKey), projectsApi.getAccess(projectKey)]);
      setProject(p.project);
      setMembers(a.members);
      setError(null);
    } catch (err) {
      setError(err as ProjectApiError);
    }
  }, [projectKey]);

  useEffect(() => {
    load();
  }, [load]);

  // Access and the project's details can change from another admin's screen.
  useSocketEvents(["member:updated", "project:updated", "project:deleted"], load);
  useOnReconnect(load);

  // People with access first, then the rest; Org Admins last since they can't be changed.
  const sorted = useMemo(() => {
    const rank = (m: ProjectAccessMember) => (m.implicit ? 2 : m.hasAccess ? 0 : 1);
    return [...(members ?? [])].sort((a, b) => rank(a) - rank(b));
  }, [members]);
  const grantedCount = members?.filter((m) => m.hasAccess && !m.implicit).length ?? 0;

  const handleGrant = async (m: ProjectAccessMember) => {
    setBusyUserId(m.userId);
    try {
      await projectsApi.grantAccess(projectKey, m.userId);
      toast.success("Access granted", `${m.firstName} ${m.lastName} can now open ${projectKey}.`);
      await load();
    } catch (err) {
      toast.error("Couldn't grant access", (err as Error).message);
    } finally {
      setBusyUserId(null);
    }
  };

  const handleRevoke = async () => {
    if (!revokeTarget) return;
    try {
      const res = await projectsApi.revokeAccess(projectKey, revokeTarget.userId);
      toast.success(
        "Access revoked",
        res.unassignedTasks > 0
          ? `${plural(res.unassignedTasks, "task")} unassigned from ${revokeTarget.firstName}.`
          : `${revokeTarget.firstName} can no longer open ${projectKey}.`
      );
      await load();
    } catch (err) {
      toast.error("Couldn't revoke access", (err as Error).message);
      throw err;
    }
  };

  if (error?.code === "PROJECT_DELETED" || error?.code === "NOT_FOUND" || error?.code === "FORBIDDEN") {
    return (
      <ErrorPage
        code={error.code === "FORBIDDEN" ? "403" : "404"}
        title={error.code === "PROJECT_DELETED" ? "This project was deleted" : error.code === "FORBIDDEN" ? "Forbidden" : "Project not found"}
        message={error.code === "FORBIDDEN" ? "Only Org Admins can change project settings." : error.message}
        home="/projects"
      />
    );
  }

  const revokeConsequences: Consequence[] = revokeTarget
    ? [
        { kind: "change", text: `${revokeTarget.firstName} can no longer open ${projectKey} or its tasks` },
        ...(revokeTarget.assignedTasks > 0
          ? [{ kind: "change" as const, text: `${plural(revokeTarget.assignedTasks, "task")} assigned to them ${revokeTarget.assignedTasks === 1 ? "becomes" : "become"} unassigned` }]
          : []),
        { kind: "keep", text: "Tasks and comments they wrote" },
      ]
    : [];

  return (
    <AppLayout>
      <div>
        <div className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
          <button type="button" onClick={() => navigate("/projects")} className="hover:text-brand-600 dark:hover:text-brand-400 cursor-pointer">
            Projects
          </button>
          <span aria-hidden="true">/</span>
          <button
            type="button"
            onClick={() => navigate(`/projects/${projectKey}/board`)}
            className="font-mono font-semibold text-brand-700 dark:text-brand-300 hover:underline cursor-pointer"
          >
            {projectKey}
          </button>
          <span aria-hidden="true">/</span>
          <span>Settings</span>
        </div>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-zinc-950 dark:text-white">Project settings</h1>
      </div>

      {!project || !members ? (
        error ? <LoadError what="this project" message={error.message} onRetry={load} /> : <Loading label="Loading project settings" />
      ) : (
        <>
          <Card padding="lg" className="max-w-3xl">
            <CardHeader>
              <div className="w-full flex items-start justify-between gap-4">
                <div>
                  <CardTitle>Details</CardTitle>
                  <CardDescription>The key is fixed; everything else can change.</CardDescription>
                </div>
                <Button variant="outline" size="sm" leftIcon={<Pencil className="w-3.5 h-3.5" />} onClick={() => setEditOpen(true)}>
                  Edit
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              <DefinitionList
                rows={[
                  { label: "Name", value: project.name },
                  { label: "Key", value: <code className="font-semibold">{project.key}</code> },
                  { label: "Description", value: project.description || <span className="text-zinc-400">None</span> },
                  { label: "Start date", value: formatDay(project.startDate) },
                  { label: "Target date", value: formatDay(project.targetDate) },
                  { label: "Created", value: formatDate(project.createdAt) },
                ]}
              />
            </CardContent>
          </Card>

          <Card padding="none" className="max-w-3xl">
            <div className="p-5 sm:p-6 border-b border-zinc-100 dark:border-dark-border">
              <h2 className="text-base font-semibold text-zinc-900 dark:text-white">Access</h2>
              <p className="text-xs sm:text-sm text-zinc-500 dark:text-zinc-400 mt-1">
                Org Admins always have access. {plural(grantedCount, "Member or Viewer", "Members and Viewers")} can open this project.
              </p>
            </div>
            {sorted.length === 0 ? (
              <EmptyState icon={<Users className="w-6 h-6" />} title="No members yet" description="Invite people to the organization first." className="border-0" />
            ) : (
              <ul className="divide-y divide-zinc-100 dark:divide-dark-border">
                {sorted.map((m) => (
                  <li key={m.userId} className="px-5 sm:px-6 py-3 flex flex-col sm:flex-row sm:items-center gap-3">
                    <button
                      type="button"
                      onClick={() => navigate(`/users/${m.userId}`)}
                      className="flex items-center gap-3 min-w-0 flex-1 text-left cursor-pointer group"
                    >
                      <Avatar size="sm" name={`${m.firstName} ${m.lastName}`} src={m.avatarPath || undefined} colorSeed={m.userId} />
                      <span className="min-w-0">
                        <span className="block text-sm font-semibold text-zinc-900 dark:text-white truncate group-hover:text-brand-600 dark:group-hover:text-brand-400">
                          {m.firstName} {m.lastName}
                        </span>
                        <span className="block text-xs text-zinc-500 dark:text-zinc-400 truncate">
                          {m.hasAccess && !m.implicit && m.grantedAt
                            ? `Access since ${formatDate(m.grantedAt)}${m.grantedByName ? ` · by ${m.grantedByName}` : ""}`
                            : m.email}
                        </span>
                      </span>
                    </button>
                    <div className="flex items-center gap-3 sm:justify-end">
                      <RoleBadge role={m.role} />
                      {m.implicit ? (
                        <Badge variant="neutral" icon={<ShieldCheck className="w-3 h-3" />}>
                          Always has access
                        </Badge>
                      ) : m.hasAccess ? (
                        <Button variant="outline" size="sm" onClick={() => setRevokeTarget(m)} disabled={busyUserId !== null}>
                          Revoke
                        </Button>
                      ) : (
                        <Button variant="primary" size="sm" onClick={() => handleGrant(m)} isLoading={busyUserId === m.userId} disabled={busyUserId !== null}>
                          Give access
                        </Button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card padding="lg" className="max-w-3xl border-destructive-200 dark:border-destructive-900">
            <CardHeader>
              <CardTitle>Delete project</CardTitle>
              <CardDescription>Deletes {project.name} and all its tasks. There's no undo in the app.</CardDescription>
            </CardHeader>
            <CardContent>
              <Button variant="destructive" leftIcon={<Trash2 className="w-4 h-4" />} onClick={() => setDeleteOpen(true)}>
                Delete project
              </Button>
            </CardContent>
          </Card>

          <ProjectFormDialog
            isOpen={editOpen}
            project={project}
            onClose={() => setEditOpen(false)}
            onSaved={(p) => {
              setEditOpen(false);
              setProject(p);
            }}
          />
          <DeleteProjectDialog
            project={project}
            isOpen={deleteOpen}
            onClose={() => setDeleteOpen(false)}
            onDeleted={() => navigate("/projects")}
          />
          <ConfirmDialog
            isOpen={Boolean(revokeTarget)}
            onClose={() => setRevokeTarget(null)}
            onConfirm={handleRevoke}
            variant="danger"
            title="Revoke access"
            description={`${revokeTarget?.firstName ?? ""} ${revokeTarget?.lastName ?? ""} will lose access to ${project.name}.`}
            confirmLabel="Revoke access"
          >
            <ConsequenceList items={revokeConsequences} />
          </ConfirmDialog>
        </>
      )}
    </AppLayout>
  );
}
