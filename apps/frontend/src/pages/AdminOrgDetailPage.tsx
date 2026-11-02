import { useCallback, useEffect, useState } from "react";
import { Pencil, Plus, Trash2, Users, FolderKanban, Mail } from "lucide-react";
import { authApi, AdminOrgDetail } from "../api/auth";
import { Alert, Avatar, Button, ConfirmDialog, EmptyState, ErrorPage, FormDialog, Input, LoadError, Loading, Tabs, Textarea, useToast } from "../components";
import { useApp } from "../context/AppContext";
import { useAsync } from "../lib/hooks";
import { AppLayout, Trail } from "./AppLayout";
import { InvitationsPanel } from "./workspace/InvitationsPanel";
import { AccountStatusBadge, ConsequenceList, Consequence, RoleBadge, RowAction } from "./admin/adminUi";
import { Project, projectsApi } from "../api/projects";
import { DeleteProjectDialog, ProjectFormDialog } from "./projects/projectUi";
import { formatDate, formatDay, plural } from "../lib/format";

type TabId = "members" | "projects" | "invitations";

export function AdminOrgDetailPage({ orgId }: { orgId: string }) {
  const { navigate } = useApp();
  const toast = useToast();
  const [org, setOrg] = useState<AdminOrgDetail | null>(null);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const [tab, setTab] = useState<TabId>("members");
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  // Projects of this org, managed by the System Admin.
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [projectForm, setProjectForm] = useState<{ project: Project | null } | null>(null);
  const [projectToDelete, setProjectToDelete] = useState<Project | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await authApi.adminGetOrg(orgId);
      setOrg(res.organization);
      setError(null);
    } catch (err) {
      const e = err as Error & { code?: string };
      setError({ code: e.code, message: e.message });
    }
  }, [orgId]);

  const loadProjects = useCallback(async () => {
    try {
      setProjects((await projectsApi.list(orgId)).projects);
    } catch (err) {
      toast.error("Couldn't load projects", (err as Error).message);
    }
  }, [orgId]);

  useEffect(() => {
    setOrg(null);
    load();
  }, [load]);

  useEffect(() => {
    if (tab === "projects") loadProjects();
  }, [tab, loadProjects]);

  const afterProjectChange = () => {
    loadProjects();
    load();
  };

  if (error?.code === "NOT_FOUND") {
    return (
      <ErrorPage
        code="404"
        title="Organization not found"
        message="This organization doesn't exist or was deleted."
        home="/admin/orgs"
      />
    );
  }

  const handleDelete = async () => {
    if (!org) return;
    try {
      const res = await authApi.adminDeleteOrg(org.id, org.name);
      toast.success("Organization deleted", res.message);
      navigate("/admin/orgs");
    } catch (err) {
      toast.error("Couldn't delete this organization", (err as Error).message);
      throw err;
    }
  };

  const deleteConsequences: Consequence[] = [];
  if (org) {
    const { projects, tasks, comments, pendingInvitations, members } = org.counts;
    if (projects > 0) {
      deleteConsequences.push({
        kind: "change",
        text: `${plural(projects, "project")}, ${plural(tasks, "task")} and ${plural(comments, "comment")} are deleted`,
      });
    }
    if (pendingInvitations > 0) {
      deleteConsequences.push({ kind: "change", text: `${plural(pendingInvitations, "pending invitation")} revoked` });
    }
    if (members === 1) {
      deleteConsequences.push({ kind: "change", text: "Its only member loses access and becomes unaffiliated" });
      deleteConsequences.push({ kind: "notify", text: `They get an email saying ${org.name} was deleted` });
    } else if (members > 1) {
      deleteConsequences.push({
        kind: "change",
        text: `${members} members lose access and become unaffiliated; friendships between them end`,
      });
      deleteConsequences.push({ kind: "notify", text: `Every member gets an email saying ${org.name} was deleted` });
    }
    if (members > 0) deleteConsequences.push({ kind: "keep", text: "Member accounts, which stay active" });
    deleteConsequences.push({ kind: "keep", text: `The name “${org.name}”, which becomes free to reuse` });
  }

  return (
    <AppLayout variant="admin" trail={<Trail items={[{ label: "Admin" }, { label: "Organizations", path: "/admin/orgs" }, { label: org?.name ?? "Organization" }]} />}>
      {!org ? (
        error ? (
          <LoadError what="this organization" message={error.message} onRetry={load} />
        ) : (
          <Loading label="Loading organization" />
        )
      ) : (
        <>
          <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-6 pb-6 mb-6 border-b border-zinc-200 dark:border-dark-border">
            <div className="min-w-0 max-w-prose">
              <h1 className="text-2xl font-bold tracking-tight text-zinc-950 dark:text-white break-words">{org.name}</h1>
              {org.description && (
                <p className="text-sm leading-relaxed text-zinc-600 dark:text-zinc-300 mt-2 whitespace-pre-line">{org.description}</p>
              )}
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-3">
                Created {formatDate(org.createdAt)} by {org.createdByName}
              </p>
            </div>
            <div className="flex flex-wrap gap-2 shrink-0">
              <Button variant="outline" onClick={() => setIsEditOpen(true)} leftIcon={<Pencil className="w-4 h-4" />}>
                Edit
              </Button>
              <Button
                variant="outline"
                onClick={() => setIsDeleteOpen(true)}
                className="text-destructive-700 dark:text-destructive-400 hover:border-destructive-400"
                leftIcon={<Trash2 className="w-4 h-4" />}
              >
                Delete
              </Button>
            </div>
          </div>

          {org.counts.members > 0 && !org.members.some((m) => m.role === "OA") && (
            <Alert variant="warning" title="No Org Admin" className="mb-6">
              Nobody can manage members or projects here. Invite one from the Invitations tab, or appoint one by editing a member.
            </Alert>
          )}

          <Tabs
            className="mb-5"
            activeTab={tab}
            onChange={(id) => setTab(id as TabId)}
            tabs={[
              { id: "members", label: "Members", count: org.counts.members, icon: <Users className="w-4 h-4" /> },
              { id: "projects", label: "Projects", count: org.counts.projects, icon: <FolderKanban className="w-4 h-4" /> },
              { id: "invitations", label: "Invitations", count: org.counts.pendingInvitations, icon: <Mail className="w-4 h-4" /> },
            ]}
          />

          {tab === "members" &&
            (org.members.length === 0 ? (
              <EmptyState
                icon={<Users className="w-6 h-6" />}
                title="No members"
                description="Invite the first Org Admin from Users to get this organization started."
                action={{ label: "Go to Users", onClick: () => navigate("/admin/users") }}
              />
            ) : (
              <ul className="border border-zinc-200 dark:border-dark-border bg-white dark:bg-dark-card divide-y divide-zinc-100 dark:divide-dark-border">
                {org.members.map((m) => (
                  <li key={m.userId}>
                    <button
                      type="button"
                      onClick={() => navigate(`/admin/users/${m.userId}`)}
                      className="w-full px-4 py-3 flex items-center gap-3 text-left hover:bg-zinc-50 dark:hover:bg-dark-elevated transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500"
                    >
                      <Avatar size="sm" name={m.fullName} src={m.avatarPath || undefined} colorSeed={m.userId} />
                      <span className="min-w-0 flex-1">
                        <span className="block font-semibold text-sm text-zinc-900 dark:text-white truncate">{m.fullName}</span>
                        <span className="block text-xs text-zinc-500 dark:text-zinc-400 truncate">{m.email}</span>
                      </span>
                      {m.accountStatus !== "ACTIVE" && <AccountStatusBadge status={m.accountStatus} />}
                      <RoleBadge role={m.role} />
                      <span className="hidden sm:block text-xs text-zinc-400 dark:text-zinc-500 w-28 text-right tabular-nums">
                        Joined {formatDate(m.joinedAt)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ))}

          {tab === "projects" && (
            <>
              <div className="flex justify-end mb-3">
                <Button size="sm" leftIcon={<Plus className="w-3.5 h-3.5" />} onClick={() => setProjectForm({ project: null })}>
                  New project
                </Button>
              </div>
              {!projects ? (
                <Loading label="Loading projects" className="py-12" />
              ) : projects.length === 0 ? (
                <EmptyState
                  icon={<FolderKanban className="w-6 h-6" />}
                  title="No projects"
                  description="Nobody has created a project in this organization yet."
                />
              ) : (
                <ul className="border border-zinc-200 dark:border-dark-border bg-white dark:bg-dark-card divide-y divide-zinc-100 dark:divide-dark-border">
                  {projects.map((p) => (
                    <li key={p.id} className="px-4 py-3 flex items-center gap-4">
                      <code className="text-xs font-semibold text-brand-700 dark:text-brand-300 bg-brand-50 dark:bg-brand-950/40 border border-brand-200/60 dark:border-brand-800/60 px-1.5 py-0.5 shrink-0">
                        {p.key}
                      </code>
                      <span className="flex-1 min-w-0">
                        <span className="block text-sm font-medium text-zinc-900 dark:text-white truncate">{p.name}</span>
                        {p.targetDate && (
                          <span className="block text-xs text-zinc-500 dark:text-zinc-400">Target {formatDay(p.targetDate)}</span>
                        )}
                      </span>
                      <span className="hidden sm:block text-xs text-zinc-500 dark:text-zinc-400 tabular-nums">
                        {plural(p.taskCount, "task")} · {p.percentDone}% done
                      </span>
                      <RowAction label={`Edit ${p.name}`} icon={<Pencil className="w-4 h-4" />} onClick={() => setProjectForm({ project: p })} />
                      <RowAction label={`Delete ${p.name}`} tone="danger" icon={<Trash2 className="w-4 h-4" />} onClick={() => setProjectToDelete(p)} />
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}

          {tab === "invitations" && (
            <InvitationsPanel orgId={org.id} orgName={org.name} canInviteOrgAdmin onChange={load} />
          )}

          <EditOrgDialog
            org={org}
            isOpen={isEditOpen}
            onClose={() => setIsEditOpen(false)}
            onSaved={() => {
              setIsEditOpen(false);
              load();
            }}
          />

          <ProjectFormDialog
            isOpen={Boolean(projectForm)}
            project={projectForm?.project}
            orgId={org.id}
            onClose={() => setProjectForm(null)}
            onSaved={() => {
              setProjectForm(null);
              afterProjectChange();
            }}
          />
          <DeleteProjectDialog
            project={projectToDelete}
            isOpen={Boolean(projectToDelete)}
            orgId={org.id}
            onClose={() => setProjectToDelete(null)}
            onDeleted={() => {
              setProjectToDelete(null);
              afterProjectChange();
            }}
          />

          <ConfirmDialog
            isOpen={isDeleteOpen}
            onClose={() => setIsDeleteOpen(false)}
            onConfirm={handleDelete}
            variant="danger"
            title="Delete organization"
            description={`${org.name} and everything in it will be deleted. There's no undo in the app.`}
            confirmLabel="Delete organization"
            typedConfirmationText={org.name}
          >
            <ConsequenceList items={deleteConsequences} />
          </ConfirmDialog>
        </>
      )}
    </AppLayout>
  );
}

function EditOrgDialog({
  org,
  isOpen,
  onClose,
  onSaved,
}: {
  org: AdminOrgDetail;
  isOpen: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState(org.name);
  const [description, setDescription] = useState(org.description ?? "");
  const { busy: saving, error, setError, run } = useAsync();

  useEffect(() => {
    if (!isOpen) return;
    setName(org.name);
    setDescription(org.description ?? "");
    setError(null);
  }, [isOpen, org]);

  const handleSubmit = async () => {
    if (await run(() => authApi.adminUpdateOrg(org.id, { name: name.trim(), description: description.trim() || undefined }))) {
      toast.success("Changes saved", "Members see the new details right away.");
      onSaved();
    }
  };

  return (
    <FormDialog
      isOpen={isOpen}
      onClose={onClose}
      title="Edit organization"
      onSubmit={handleSubmit}
      submitLabel="Save changes"
      busy={saving}
      error={error}
      onDismissError={() => setError(null)}
    >
        <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={100} disabled={saving} />
        <Textarea
          label="Description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={1000}
          rows={4}
          disabled={saving}
        />
    </FormDialog>
  );
}