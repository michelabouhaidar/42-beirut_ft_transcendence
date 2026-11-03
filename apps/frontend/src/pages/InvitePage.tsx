import { ReactNode, useCallback, useEffect, useState } from "react";
import { Clock, Link2Off, MailX, ShieldOff, UserCheck, XCircle } from "lucide-react";
import { authApi, InvitationPreview, User } from "../api/auth";
import { useAuth } from "../context/AuthContext";
import { Alert, Button, Card, EmptyState, Input, Loading, Logo, PasswordChecklist, PasswordMatchIndicator, TermsCheckbox, ThemeToggle, useToast } from "../components";
import { useApp } from "../context/AppContext";
import type { ApiError } from "../api/http";
import { formatDate } from "../lib/format";

const ROLE_COPY: Record<InvitationPreview["role"], { name: string; does: string }> = {
  OA: { name: "Org Admin", does: "You'll manage members, invitations and every project." },
  MEMBER: { name: "Member", does: "You'll create and edit tasks in the projects you're given access to." },
  VIEWER: { name: "Viewer", does: "You'll see the projects you're given access to, read-only." },
};

// Dead or unknown links (API 404 / 410, INV-04): say what happened and what to do next.
const DEAD_LINK: Record<string, { title: string; icon: ReactNode; signIn?: boolean }> = {
  INVITATION_NOT_FOUND: { title: "This invitation link isn't valid", icon: <Link2Off className="w-6 h-6" /> },
  INVITATION_EXPIRED: { title: "This invitation has expired", icon: <Clock className="w-6 h-6" /> },
  INVITATION_REVOKED: { title: "This invitation was cancelled", icon: <XCircle className="w-6 h-6" /> },
  INVITATION_USED: { title: "This invitation was already used", icon: <UserCheck className="w-6 h-6" />, signIn: true },
  INVITATION_DECLINED: { title: "This invitation was declined", icon: <MailX className="w-6 h-6" /> },
  ORG_DELETED: { title: "This organization no longer exists", icon: <ShieldOff className="w-6 h-6" /> },
};

// Loads an invitation by its emailed token; a dead link (API 404 / 410) carries its code.
export function useInvitation<T>(fetch: () => Promise<{ invitation: T; accountExists: boolean }>, token: string) {
  const [invitation, setInvitation] = useState<T | null>(null);
  const [accountExists, setAccountExists] = useState(false);
  const [deadLink, setDeadLink] = useState<{ code: string; message: string } | null>(null);
  const load = useCallback(async () => {
    try {
      const res = await fetch();
      setInvitation(res.invitation);
      setAccountExists(res.accountExists);
      setDeadLink(null);
    } catch (err) {
      const e = err as ApiError;
      setDeadLink({ code: e.code || "INVITATION_NOT_FOUND", message: e.message });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);
  useEffect(() => {
    load();
  }, [load]);
  return { invitation, accountExists, setAccountExists, deadLink, setDeadLink, load };
}

// Logo and theme switch above a narrow column, for the public invitation pages.
export function InviteShell({ children, deadLink, home, loading }: { children: ReactNode; deadLink: { code: string; message: string } | null; home: string; loading: boolean }) {
  const { navigate } = useApp();
  const { user } = useAuth();
  const dead = deadLink && (DEAD_LINK[deadLink.code] ?? DEAD_LINK.INVITATION_NOT_FOUND);
  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-dark-bg text-zinc-900 dark:text-zinc-100 flex flex-col font-sans transition-colors">
      <header className="h-16 px-4 sm:px-8 flex items-center justify-between border-b border-zinc-200 dark:border-dark-border bg-white/95 dark:bg-dark-bg/95">
        <Button variant="quiet" onClick={() => navigate("/")} aria-label="Trenno home">
          <Logo size="sm" />
        </Button>
        <ThemeToggle />
      </header>
      <main className="flex-1 w-full max-w-lg mx-auto px-4 py-10 sm:py-16">
        {deadLink && dead ? (
          <EmptyState
            icon={dead.icon}
            title={dead.title}
            description={deadLink.message}
            action={dead.signIn && !user ? { label: "Sign in", onClick: () => navigate("/login") } : { label: "Go to Trenno", onClick: () => navigate(user ? home : "/") }}
          />
        ) : loading ? (
          <Loading label="Loading invitation" />
        ) : (
          children
        )}
      </main>
    </div>
  );
}

export function InvitePage({ token }: { token: string }) {
  const toast = useToast();
  const { navigate } = useApp();
  const { user, organization, role, isLoading: authLoading, setAuthData, logout } = useAuth();
  const { invitation, accountExists, setAccountExists, deadLink, setDeadLink, load } = useInvitation(() => authApi.getInvitationByToken(token), token);
  const [declined, setDeclined] = useState(false);

  const joined = (orgName: string) => {
    toast.success(`Welcome to ${orgName}`, "Your workspace is ready.");
    navigate("/projects");
  };

  return (
    <InviteShell deadLink={deadLink} home="/onboarding" loading={!invitation || authLoading}>
      {invitation &&
        (declined ? (
          <EmptyState
            icon={<MailX className="w-6 h-6" />}
            title="Invitation declined"
            description={`You won't join ${invitation.organization.name}. Ask for a new invitation if you change your mind.`}
            action={{ label: "Go to Trenno", onClick: () => navigate("/onboarding") }}
          />
        ) : (
          <Card padding="lg" className="space-y-8">
            {/* The invitation itself */}
            <div>
              <p className="text-sm text-zinc-500 dark:text-zinc-400">{invitation.invitedByName} invited you to join</p>
              <h1 className="mt-1 text-3xl font-bold tracking-tight text-zinc-950 dark:text-white break-words">
                {invitation.organization.name}
              </h1>
              {invitation.organization.description && (
                <p className="mt-3 text-sm leading-relaxed text-zinc-600 dark:text-zinc-300">{invitation.organization.description}</p>
              )}
              <dl className="mt-6 grid grid-cols-[6rem_1fr] gap-y-3 text-sm border-t border-zinc-100 dark:border-dark-border pt-5">
                <dt className="text-zinc-500 dark:text-zinc-400">Your role</dt>
                <dd>
                  <span className="font-semibold text-zinc-900 dark:text-white">{ROLE_COPY[invitation.role].name}</span>
                  <span className="block text-zinc-600 dark:text-zinc-300 mt-0.5">{ROLE_COPY[invitation.role].does}</span>
                </dd>
                <dt className="text-zinc-500 dark:text-zinc-400">Sent to</dt>
                <dd className="text-zinc-900 dark:text-white break-all">{invitation.email}</dd>
                <dt className="text-zinc-500 dark:text-zinc-400">Expires</dt>
                <dd className="text-zinc-900 dark:text-white">{formatDate(invitation.expiresAt, false, "long")}</dd>
              </dl>
            </div>

            {/* What this visitor can do with it */}
            <div className="border-t border-zinc-100 dark:border-dark-border pt-6">
              {user ? (
                <SignedInActions
                  invitation={invitation}
                  userEmail={user.email}
                  isSystemAdmin={user.isSystemAdmin || role === "SA"}
                  currentOrgName={organization?.name ?? null}
                  onAccepted={(org, newRole) => {
                    setAuthData(user, org, newRole);
                    joined(org.name);
                  }}
                  onDeclined={() => setDeclined(true)}
                  onSignOut={async () => {
                    await logout();
                    load();
                  }}
                  onOpenWorkspace={() => navigate("/projects")}
                />
              ) : accountExists ? (
                <div className="space-y-4">
                  <p className="text-sm text-zinc-600 dark:text-zinc-300">
                    {invitation.email} already has a Trenno account. Sign in with it to accept.
                  </p>
                  <Button fullWidth onClick={() => navigate(`/login?redirect=${encodeURIComponent(`/invite/${token}`)}`)}>
                    Sign in to accept
                  </Button>
                </div>
              ) : (
                <NewAccountForm
                  email={invitation.email}
                  submit={(payload) => authApi.acceptInvitationAsNew(token, payload)}
                  onJoined={(u, org, newRole) => {
                    setAuthData(u, org, newRole);
                    joined(org!.name);
                  }}
                  onAccountExists={() => setAccountExists(true)}
                  onDeadLink={(code, message) => setDeadLink({ code, message })}
                />
              )}
            </div>
          </Card>
        ))}
    </InviteShell>
  );
}

// Existing account, signed in.
function SignedInActions({
  invitation,
  userEmail,
  isSystemAdmin,
  currentOrgName,
  onAccepted,
  onDeclined,
  onSignOut,
  onOpenWorkspace,
}: {
  invitation: InvitationPreview;
  userEmail: string;
  isSystemAdmin: boolean;
  currentOrgName: string | null;
  onAccepted: (org: { id: string; name: string }, role: "OA" | "MEMBER" | "VIEWER") => void;
  onDeclined: () => void;
  onSignOut: () => void;
  onOpenWorkspace: () => void;
}) {
  const [busy, setBusy] = useState<"accept" | "decline" | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (userEmail.toLowerCase() !== invitation.email.toLowerCase()) {
    return (
      <Alert
        variant="warning"
        title="This invitation is for a different account"
        action={
          <Button variant="outline" size="sm" onClick={onSignOut}>
            Sign out
          </Button>
        }
      >
        It was sent to {invitation.email}, and you're signed in as {userEmail}. Sign out, then sign in as {invitation.email} to accept it.
      </Alert>
    );
  }

  if (isSystemAdmin) {
    return (
      <Alert variant="info" title="System Admins don't join organizations">
        Your account manages the whole platform, so it can't accept an organization invitation.
      </Alert>
    );
  }

  if (currentOrgName && currentOrgName !== invitation.organization.name) {
    return (
      <Alert
        variant="warning"
        title={`You're already a member of ${currentOrgName}`}
        action={
          <Button variant="outline" size="sm" onClick={onOpenWorkspace}>
            Open my workspace
          </Button>
        }
      >
        A Trenno account belongs to one organization at a time. Leave {currentOrgName} first, then come back to this link to accept.
      </Alert>
    );
  }

  const run = async (kind: "accept" | "decline") => {
    setBusy(kind);
    setError(null);
    try {
      if (kind === "accept") {
        const res = await authApi.acceptInvitation(invitation.id);
        onAccepted(res.organization, res.role as "OA" | "MEMBER" | "VIEWER");
      } else {
        await authApi.declineInvitation(invitation.id);
        onDeclined();
      }
    } catch (err) {
      setError((err as Error).message);
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      {error && <Alert variant="error">{error}</Alert>}
      <div className="flex flex-col sm:flex-row gap-2">
        <Button fullWidth onClick={() => run("accept")} isLoading={busy === "accept"} disabled={busy !== null}>
          Accept and join
        </Button>
        <Button fullWidth variant="outline" onClick={() => run("decline")} isLoading={busy === "decline"} disabled={busy !== null}>
          Decline
        </Button>
      </div>
    </div>
  );
}

// New person. The link proves the email, so it's shown read-only.
export function NewAccountForm({
  email,
  submit,
  heading = "Create your account to join",
  submitLabel = "Create account and join",
  onJoined,
  onAccountExists,
  onDeadLink,
}: {
  email: string;
  submit: (payload: { firstName: string; lastName: string; password: string; passwordConfirmation: string; acceptTerms: boolean }) => Promise<{
    user: User;
    organization: { id: string; name: string } | null;
    role: "OA" | "MEMBER" | "VIEWER" | "SA";
  }>;
  heading?: string;
  submitLabel?: string;
  onJoined: (user: User, org: { id: string; name: string } | null, role: "OA" | "MEMBER" | "VIEWER" | "SA") => void;
  onAccountExists: () => void;
  onDeadLink: (code: string, message: string) => void;
}) {
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [acceptTerms, setAcceptTerms] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: { preventDefault: () => void }) => {
    e.preventDefault();
    setError(null);
    if (password !== passwordConfirmation) {
      setError("Passwords do not match.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await submit({
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        password,
        passwordConfirmation,
        acceptTerms,
      });
      onJoined(res.user, res.organization, res.role);
    } catch (err) {
      const e = err as ApiError;
      if (e.code === "ACCOUNT_EXISTS") onAccountExists();
      else if (e.code && e.code in DEAD_LINK) onDeadLink(e.code, e.message);
      else setError(e.message);
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <h2 className="text-base font-bold text-zinc-900 dark:text-white">{heading}</h2>
      {error && (
        <Alert appearance="inline" variant="error">
          {error}
        </Alert>
      )}
      <Input label="Email" type="email" value={email} readOnly disabled helperText="This is the address the invitation was sent to." />
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Input label="First name" value={firstName} onChange={(e) => setFirstName(e.target.value)} required maxLength={50} autoComplete="given-name" />
        <Input label="Last name" value={lastName} onChange={(e) => setLastName(e.target.value)} required maxLength={50} autoComplete="family-name" />
      </div>
      <div>
        <Input label="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="new-password" />
        <PasswordChecklist password={password} />
      </div>
      <div>
        <Input
          label="Confirm password"
          type="password"
          value={passwordConfirmation}
          onChange={(e) => setPasswordConfirmation(e.target.value)}
          required
          autoComplete="new-password"
        />
        <PasswordMatchIndicator password={password} confirmPassword={passwordConfirmation} />
      </div>
      <TermsCheckbox checked={acceptTerms} onChange={setAcceptTerms} />
      <Button type="submit" fullWidth isLoading={submitting}>
        {submitLabel}
      </Button>
    </form>
  );
}
