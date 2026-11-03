import { useCallback, useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Ban, ChevronLeft, ChevronRight, Pencil, RotateCcw, Search, ShieldCheck, Trash2, UserPlus, Users } from "lucide-react";
import { authApi, AccountStatus, AdminOrgItem, AdminUserListItem, AdminUserSort, AdminUsersResponse, OrgRole } from "../api/auth";
import { Alert, Avatar, Badge, Button, EmptyState, FormDialog, Input, LoadError, PageHeader, Select, Spinner, Tabs, useToast } from "../components";
import { useApp } from "../context/AppContext";
import { useAsync, useDebounced } from "../lib/hooks";
import { formatDate, formatRelative } from "../lib/format";
import { AppLayout, Trail } from "./AppLayout";
import { UserActionDialogs, UserActionRequest } from "./admin/UserActionDialogs";
import { ROLE_LABELS, RowAction, STATUS_LABELS, blockedReason } from "./admin/adminUi";

const STATUS_ORDER: AccountStatus[] = ["ACTIVE", "PENDING_VERIFICATION", "SUSPENDED", "DELETED"];

const ROLE_FILTERS = [
  { value: "ALL", label: "Any role" },
  { value: "SA", label: "System Admin" },
  { value: "OA", label: "Org Admin" },
  { value: "MEMBER", label: "Member" },
  { value: "VIEWER", label: "Viewer" },
  { value: "U", label: "No organization" },
];

const PAGE_SIZES = [10, 25, 50].map((n) => ({ value: String(n), label: String(n) }));

interface Filters {
  page: number;
  limit: number;
  status: "ALL" | AccountStatus;
  role: string;
  orgId: string;
  sort: AdminUserSort;
  order: "asc" | "desc";
}

const DEFAULT_FILTERS: Filters = { page: 1, limit: 25, status: "ALL", role: "ALL", orgId: "ALL", sort: "createdAt", order: "desc" };
const orNone = (v: string) => (v === "ALL" ? undefined : v);

export function AdminUsersPage() {
  const { navigate } = useApp();
  const [data, setData] = useState<AdminUsersResponse | null>(null);
  const [orgs, setOrgs] = useState<AdminOrgItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const q = useDebounced(searchQuery.trim(), 300);
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [actionRequest, setActionRequest] = useState<UserActionRequest | null>(null);
  const [isInviteOpen, setIsInviteOpen] = useState(false);

  // Any filter change starts again from page 1.
  const filter = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, page: 1, ...patch }));
  useEffect(() => setFilters((f) => (f.page === 1 ? f : { ...f, page: 1 })), [q]);

  useEffect(() => {
    authApi
      .adminGetOrgs()
      .then((res) => setOrgs(res.organizations))
      .catch(() => setOrgs([]));
  }, []);

  const fetchUsers = useCallback(async () => {
    setIsLoading(true);
    try {
      const { status, role, orgId, ...rest } = filters;
      setData(await authApi.adminGetUsers({ ...rest, q: q || undefined, status: orNone(status), role: orNone(role), orgId: orNone(orgId) }));
      setLoadError(null);
    } catch (err) {
      setLoadError((err as Error).message);
    } finally {
      setIsLoading(false);
    }
  }, [filters, q]);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  const handleSort = (field: AdminUserSort) =>
    filter(filters.sort === field ? { order: filters.order === "asc" ? "desc" : "asc" } : { sort: field, order: field === "lastLoginAt" ? "desc" : "asc" });

  const hasFilters = Boolean(q) || filters.role !== "ALL" || filters.orgId !== "ALL" || filters.status !== "ALL";
  const clearFilters = () => {
    setSearchQuery("");
    filter({ role: "ALL", orgId: "ALL", status: "ALL" });
  };

  const users = data?.users ?? [];
  const counts = data?.statusCounts;
  const { page, limit } = filters;
  const total = data?.pagination.total ?? 0;
  const totalPages = data?.pagination.totalPages ?? 1;
  const statusTabs = [
    { id: "ALL", label: "All", count: counts ? STATUS_ORDER.reduce((n, s) => n + counts[s], 0) : undefined },
    ...STATUS_ORDER.map((s) => ({ id: s, label: STATUS_LABELS[s], count: counts?.[s] })),
  ];
  const orgOptions = [{ value: "ALL", label: "Any organization" }, { value: "unaffiliated", label: "No organization" }, ...orgs.map((o) => ({ value: o.id, label: o.name }))];
  const sortHeader = (label: string, field: AdminUserSort) => <SortHeader label={label} field={field} sort={filters.sort} order={filters.order} onSort={handleSort} />;

  return (
    <AppLayout variant="admin" trail={<Trail items={[{ label: "Admin" }, { label: "Users" }]} />}>
      <PageHeader
        className="mb-6"
        title="Users"
        subtitle="Every account on Trenno. Open someone to edit their profile or role, suspend or delete them."
        actions={
          <Button onClick={() => setIsInviteOpen(true)} leftIcon={<UserPlus className="w-4 h-4" />}>
            Invite user
          </Button>
        }
      />

      {/* Status strip: summary and filter in one control */}
      <div className="overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0 mb-4">
        <Tabs className="w-max" variant="segmented" size="sm" tabs={statusTabs} activeTab={filters.status} onChange={(id) => filter({ status: id as Filters["status"] })} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)] gap-3 mb-4">
        <Input
          type="search"
          aria-label="Search users"
          placeholder="Search by name or email"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          leftIcon={<Search className="w-4 h-4" />}
        />
        <Select value={filters.role} onChange={(role) => filter({ role })} options={ROLE_FILTERS} />
        <Select value={filters.orgId} onChange={(orgId) => filter({ orgId })} options={orgOptions} />
      </div>

      {loadError && <LoadError className="mb-4" what="users" message={loadError} onRetry={fetchUsers} />}

      <div className="border border-zinc-200 dark:border-dark-border bg-white dark:bg-dark-card">
        {/* relative: keeps the sr-only header inside the scroller on narrow screens */}
        <div className="relative overflow-x-auto">
          <table className="w-full text-left text-sm border-collapse min-w-[860px]">
            <thead>
              <tr className="border-b border-zinc-200 dark:border-dark-border text-xs text-zinc-500 dark:text-zinc-400">
                {sortHeader("User", "name")}
                {sortHeader("Status", "status")}
                <th scope="col" className="py-2.5 px-4 font-medium">
                  Organization
                </th>
                <th scope="col" className="py-2.5 px-4 font-medium">
                  Role
                </th>
                <th scope="col" className="py-2.5 px-4 font-medium">
                  2FA
                </th>
                {sortHeader("Last login", "lastLoginAt")}
                <th scope="col" className="py-2.5 px-4 font-medium text-right">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-dark-border">
              {isLoading && users.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-16">
                    <div className="flex justify-center">
                      <Spinner size="lg" label="Loading users" />
                    </div>
                  </td>
                </tr>
              ) : users.length === 0 ? (
                <tr>
                  <td colSpan={7} className="p-4">
                    <EmptyState
                      className="border-0"
                      icon={<Users className="w-6 h-6" />}
                      title="No users match"
                      description={hasFilters ? "Nobody matches these filters. Clear them to see everyone." : "Invite the first person to get started."}
                      action={hasFilters ? { label: "Clear filters", onClick: clearFilters } : { label: "Invite user", onClick: () => setIsInviteOpen(true) }}
                    />
                  </td>
                </tr>
              ) : (
                users.map((u) => (
                  <UserRow key={u.id} user={u} onOpen={() => navigate(`/admin/users/${u.id}`)} onAction={(action) => setActionRequest({ action, userId: u.id })} />
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="flex flex-col sm:flex-row items-center justify-between gap-3 px-4 py-3 border-t border-zinc-200 dark:border-dark-border text-xs text-zinc-500 dark:text-zinc-400">
          <div className="flex items-center gap-3">
            <span className="tabular-nums">
              {total === 0 ? 0 : (page - 1) * limit + 1}–{Math.min(page * limit, total)} of {total}
            </span>
            {isLoading && users.length > 0 && <Spinner size="xs" variant="muted" label="Refreshing" />}
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <span>Rows</span>
              <Select className="w-20" value={String(limit)} onChange={(v) => filter({ limit: Number(v) })} options={PAGE_SIZES} />
            </div>
            <div className="flex items-center gap-1">
              <Button variant="outline" size="sm" aria-label="Previous page" onClick={() => setFilters({ ...filters, page: page - 1 })} disabled={page <= 1 || isLoading}>
                <ChevronLeft className="w-3.5 h-3.5" />
              </Button>
              <span className="px-2 tabular-nums">
                {page} / {totalPages}
              </span>
              <Button variant="outline" size="sm" aria-label="Next page" onClick={() => setFilters({ ...filters, page: page + 1 })} disabled={page >= totalPages || isLoading}>
                <ChevronRight className="w-3.5 h-3.5" />
              </Button>
            </div>
          </div>
        </div>
      </div>

      <UserActionDialogs
        request={actionRequest}
        onClose={() => setActionRequest(null)}
        onDone={() => {
          setActionRequest(null);
          fetchUsers();
        }}
      />
      <InviteUserDialog isOpen={isInviteOpen} onClose={() => setIsInviteOpen(false)} orgs={orgs} />
    </AppLayout>
  );
}

function SortHeader({ label, field, sort, order, onSort }: { label: string; field: AdminUserSort; sort: AdminUserSort; order: "asc" | "desc"; onSort: (f: AdminUserSort) => void }) {
  const active = sort === field;
  const Arrow = order === "asc" ? ArrowUp : ArrowDown;
  return (
    <th scope="col" aria-sort={active ? (order === "asc" ? "ascending" : "descending") : "none"} className="py-2.5 px-4 font-medium">
      <button
        type="button"
        onClick={() => onSort(field)}
        className={`inline-flex items-center gap-1 cursor-pointer hover:text-zinc-900 dark:hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
          active ? "text-zinc-900 dark:text-white" : ""
        }`}
      >
        {label}
        {active && <Arrow className="w-3 h-3" aria-hidden="true" />}
      </button>
    </th>
  );
}

function UserRow({ user: u, onOpen, onAction }: { user: AdminUserListItem; onOpen: () => void; onAction: (action: "edit" | "suspend" | "reactivate" | "delete") => void }) {
  const isDeleted = u.status === "DELETED";
  return (
    <tr onClick={onOpen} className={`group cursor-pointer hover:bg-zinc-50 dark:hover:bg-dark-elevated transition-colors ${isDeleted ? "text-zinc-400 dark:text-zinc-500" : ""}`}>
      <td className="py-3 px-4">
        <div className="flex items-center gap-3 min-w-0">
          <Avatar size="sm" name={u.fullName} src={u.avatarPath || undefined} colorSeed={u.id} className={isDeleted ? "opacity-50" : ""} />
          <div className="min-w-0">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onOpen();
              }}
              className={`font-semibold truncate max-w-[16rem] block text-left cursor-pointer hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
                isDeleted ? "" : "text-zinc-900 dark:text-white"
              }`}
            >
              {u.fullName}
              {u.guards.isSelf && <span className="ml-1.5 font-normal text-zinc-400">(you)</span>}
            </button>
            <div className="text-xs text-zinc-500 dark:text-zinc-400 truncate max-w-[16rem]">{u.email}</div>
          </div>
        </div>
      </td>
      <td className="py-3 px-4 whitespace-nowrap">{STATUS_LABELS[u.status]}</td>
      <td className="py-3 px-4">
        {u.organization ? <span className="block truncate max-w-[12rem]">{u.organization.name}</span> : <span className="text-zinc-400 dark:text-zinc-500">None</span>}
      </td>
      <td className="py-3 px-4 whitespace-nowrap">{ROLE_LABELS[u.role]}</td>
      <td className="py-3 px-4">
        {u.twoFactorEnabled ? (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-success-700 dark:text-success-400">
            <ShieldCheck className="w-3.5 h-3.5" aria-hidden="true" />
            On
          </span>
        ) : (
          <span className="text-xs text-zinc-400 dark:text-zinc-500">Off</span>
        )}
      </td>
      <td className="py-3 px-4 text-xs text-zinc-500 dark:text-zinc-400 whitespace-nowrap" title={formatDate(u.lastLoginAt, true)}>
        {formatRelative(u.lastLoginAt)}
      </td>
      <td className="py-3 px-4">
        {!isDeleted && (
          <div className="flex items-center justify-end gap-0.5">
            <RowAction label={`Edit ${u.fullName}`} icon={<Pencil className="w-4 h-4" />} onClick={() => onAction("edit")} />
            {u.status === "SUSPENDED" ? (
              <RowAction label={`Reactivate ${u.fullName}`} icon={<RotateCcw className="w-4 h-4" />} onClick={() => onAction("reactivate")} />
            ) : (
              <RowAction label={`Suspend ${u.fullName}`} icon={<Ban className="w-4 h-4" />} onClick={() => onAction("suspend")} disabledReason={blockedReason(u, "suspend")} />
            )}
            <RowAction
              label={`Delete ${u.fullName}`}
              icon={<Trash2 className="w-4 h-4" />}
              tone="danger"
              onClick={() => onAction("delete")}
              disabledReason={blockedReason(u, "delete")}
            />
          </div>
        )}
      </td>
    </tr>
  );
}

const INVITE_ROLES: Array<{ value: "SA" | OrgRole; label: string; description: string }> = [
  { value: "MEMBER", label: "Member", description: "Creates and edits tasks in projects they can access" },
  { value: "VIEWER", label: "Viewer", description: "Read-only in projects they can access" },
  { value: "OA", label: "Org Admin", description: "Manages the organization's members and projects" },
  { value: "SA", label: "System Admin", description: "Manages every user and organization; joins no organization" },
];

function InviteUserDialog({ isOpen, onClose, orgs }: { isOpen: boolean; onClose: () => void; orgs: AdminOrgItem[] }) {
  const toast = useToast();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"SA" | OrgRole>("MEMBER");
  const [orgId, setOrgId] = useState("");
  const { busy, error, setError, run } = useAsync();

  useEffect(() => {
    if (!isOpen) return;
    setEmail("");
    setRole("MEMBER");
    setOrgId(orgs[0]?.id ?? "");
    setError(null);
  }, [isOpen, orgs]);

  const needsOrg = role !== "SA";
  const orgName = orgs.find((o) => o.id === orgId)?.name;

  const submit = async () => {
    if (needsOrg && !orgId) return setError("Pick the organization they'll join.");
    const res = await run(() => authApi.adminCreateInvitation({ email: email.trim().toLowerCase(), role, orgId: needsOrg ? orgId : undefined }));
    if (res) {
      toast.success("Invitation sent", res.message);
      onClose();
    }
  };

  return (
    <FormDialog
      isOpen={isOpen}
      onClose={onClose}
      title="Invite user"
      maxWidth="xl"
      description="They get an email with a link to create their account. Invitations expire after 7 days."
      onSubmit={submit}
      submitLabel="Send invitation"
      busy={busy}
      submitDisabled={needsOrg && orgs.length === 0}
      error={error}
      onDismissError={() => setError(null)}
      footerNote={
        <p className="text-xs text-zinc-500 dark:text-zinc-400">{role === "SA" ? <Badge variant="SA">Platform-wide access</Badge> : orgName ? <>Joins {orgName}</> : null}</p>
      }
    >
      <Input label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" required autoFocus disabled={busy} />
      <Select label="Role" value={role} onChange={(v) => setRole(v as "SA" | OrgRole)} options={INVITE_ROLES} disabled={busy} />
      {needsOrg &&
        (orgs.length === 0 ? (
          <Alert variant="info">There are no organizations yet. Create one first, or invite a System Admin.</Alert>
        ) : (
          <Select label="Organization" value={orgId} onChange={setOrgId} options={orgs.map((o) => ({ value: o.id, label: o.name }))} disabled={busy} />
        ))}
    </FormDialog>
  );
}