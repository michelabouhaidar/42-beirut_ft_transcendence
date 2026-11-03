import { useEffect } from "react";
import { AuthPopup, AuthPopupView, ErrorPage, SignedIn, ToastProvider } from "./components";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { AppProvider, AUTH_ROUTES, useApp } from "./context/AppContext";
import { RealtimeProvider } from "./context/RealtimeContext";
import { NotificationsProvider } from "./context/NotificationsContext";
import { LandingPage } from "./pages/LandingPage";
import { OnboardingPage } from "./pages/OnboardingPage";
import { AdminUsersPage } from "./pages/AdminUsersPage";
import { AdminOrgsPage } from "./pages/AdminOrgsPage";
import { AdminUserDetailPage } from "./pages/AdminUserDetailPage";
import { AdminOrgDetailPage } from "./pages/AdminOrgDetailPage";
import { InvitePage } from "./pages/InvitePage";
import { SaInvitePage } from "./pages/SaInvitePage";
import { OrgSettingsPage } from "./pages/OrgSettingsPage";
import { MembersPage } from "./pages/MembersPage";
import { FriendsPage } from "./pages/FriendsPage";
import { UserProfilePage } from "./pages/UserProfilePage";
import { ProjectPage } from "./pages/ProjectPage";
import { SearchPage } from "./pages/SearchPage";
import { ProjectSettingsPage } from "./pages/ProjectSettingsPage";
import { NotificationsInbox } from "./pages/NotificationsPage";
import { AppLayout } from "./pages/AppLayout";
import { LegalPage } from "./pages/LegalPage";

// Pages inside an organization workspace.
const WORKSPACE_PAGES = ["/onboarding", "/projects", "/search", "/notifications", "/friends"];
const isWorkspaceRoute = (path: string) =>
  WORKSPACE_PAGES.includes(path) || path.startsWith("/projects/") || path.startsWith("/users/") || path.startsWith("/org/");

const AUTH_VIEWS: Record<string, AuthPopupView> = {
  "/login": "login",
  "/signup": "signup",
  "/verify": "verify",
  "/forgot-password": "forgot-password",
  "/reset-password": "reset-password",
};

const UUID = "([0-9a-f-]{36})";
const queryParam = (name: string) => new URLSearchParams(window.location.search).get(name);

// A pending destination from redirect after login.
function safeRedirect(): string | null {
  const redirect = queryParam("redirect");
  return redirect && redirect.startsWith("/") && !redirect.startsWith("//") && !redirect.startsWith("/\\") && !AUTH_ROUTES.includes(redirect) ? redirect : null;
}

function MainApp() {
  const { user, organization, role, isLoading, isSA } = useAuth();
  const { path, navigate } = useApp();
  const isUnaffiliated = !isSA && (role === "U" || !organization);
  const home = isSA ? "/admin/users" : isUnaffiliated ? "/onboarding" : "/projects";

  // Route guards.
  useEffect(() => {
    if (isLoading) return;
    if (!user) {
      // Signed out: protected pages go to /login and come back afterwards.
      if (isWorkspaceRoute(path) || path.startsWith("/admin")) navigate(`/login${path !== "/" ? `?redirect=${encodeURIComponent(path)}` : ""}`);
      else if (path === "/reset-password" && !queryParam("token")) navigate("/forgot-password");
      else if (path === "/verify" && !queryParam("token")) navigate("/login");
      return;
    }
    if (AUTH_ROUTES.includes(path)) navigate(isSA || isUnaffiliated ? home : safeRedirect() ?? "/projects");
    // A System Admin belongs to no organization: their home is the Admin menu.
    else if (isSA && isWorkspaceRoute(path)) navigate("/admin/users");
    else if (isUnaffiliated && (path === "/projects" || path.startsWith("/projects/"))) navigate("/onboarding");
  }, [user, role, organization, isLoading, path]);

  // Privacy Policy and Terms of Service: public pages, signed in or out.
  if (path === "/privacy" || path === "/terms") return <LegalPage key={path} doc={path === "/privacy" ? "privacy" : "terms"} />;

  // Invitation links from the email: public, signed in or out.
  const invite = path.match(/^\/(invite|sa-invite)\/([A-Za-z0-9]+)$/);
  if (invite) return invite[1] === "invite" ? <InvitePage key={invite[2]} token={invite[2]} /> : <SaInvitePage key={invite[2]} token={invite[2]} />;

  if (user) {
    const page = userPage(path, role, isSA, home);
    if (page !== undefined) return page;
  }

  const isLanding = path === "/" || path in AUTH_VIEWS;
  if (!isLanding) return <ErrorPage code="404" title="Page not found" message="The page you are looking for does not exist." home={user ? home : "/"} />;

  let authView: AuthPopupView | null = !isLoading && !user ? AUTH_VIEWS[path] ?? null : null;
  if ((authView === "verify" || authView === "reset-password") && !queryParam("token")) authView = null;

  const onSignedIn = (info: SignedIn) => {
    // A pending destination wins; the route guards still apply once there.
    const redirect = safeRedirect();
    if (redirect) navigate(redirect);
    else if (info.isSystemAdmin) navigate("/admin/users");
    else navigate(!info.hasOrg || info.role === "U" ? "/onboarding" : "/projects");
  };

  return (
    <>
      <LandingPage />
      <AuthPopup view={authView} onClose={() => navigate("/")} onSwitchView={(view) => navigate(`/${view}`)} onSignedIn={onSignedIn} />
    </>
  );
}

// Signed-in routes and role checks. undefined = not one of these pages.
function userPage(path: string, role: string | null, isSA: boolean, home: string) {
  const forbidden = (message: string, to: string, title = "Forbidden") => <ErrorPage code="403" title={title} message={message} home={to} />;

  // Platform administration (System Admins only).
  if (path.startsWith("/admin")) {
    if (!isSA) return forbidden("System Administrator privileges required to access platform administration.", home);
    const userMatch = path.match(new RegExp(`^/admin/users/${UUID}$`, "i"));
    const orgMatch = path.match(new RegExp(`^/admin/orgs/${UUID}$`, "i"));
    if (path === "/admin" || path === "/admin/users") return <AdminUsersPage />;
    if (userMatch) return <AdminUserDetailPage key={userMatch[1]} userId={userMatch[1]} />;
    if (path === "/admin/orgs") return <AdminOrgsPage />;
    if (orgMatch) return <AdminOrgDetailPage key={orgMatch[1]} orgId={orgMatch[1]} />;
    if (path === "/admin/notifications") {
      return (
        <AppLayout variant="admin" trail="Notifications">
          <div className="space-y-6">
            <NotificationsInbox />
          </div>
        </AppLayout>
      );
    }
    return <ErrorPage code="404" title="Admin resource not found" message="The requested administrative page does not exist." home="/admin/users" />;
  }

  // System Admins are redirected to /admin/users by the guard.
  if (isSA && isWorkspaceRoute(path)) return null;

  // Organization settings and invitations (Org Admins only).
  if (path === "/org/settings" || path === "/org/invitations") {
    if (role !== "OA") return forbidden("Organization Administrator (OA) privileges required to access organization settings or invitations.", "/projects");
    return path === "/org/settings" ? <OrgSettingsPage /> : <MembersPage tab="invitations" />;
  }

  // Unaffiliated users can't open projects or organization pages.
  if (role === "U" && (path.startsWith("/projects") || path.startsWith("/org") || path === "/friends" || path === "/search" || path.startsWith("/users/"))) {
    return forbidden(
      "You are currently unaffiliated. Please create an organization or accept an invitation to access projects and organization menus.",
      "/onboarding",
      "Workspace required"
    );
  }

  if (path === "/org/members") return <MembersPage />;
  if (path === "/friends") return <FriendsPage />;
  // Notification also open to unaffiliated users (invitations reach them here).
  if (path === "/notifications") {
    return (
      <AppLayout>
        <NotificationsInbox />
      </AppLayout>
    );
  }
  // Task search; filters live in the query string.
  if (path === "/search") return <SearchPage />;

  const profile = path.match(new RegExp(`^/users/${UUID}$`, "i"));
  if (profile) return <UserProfilePage key={profile[1]} userId={profile[1]} />;

  // Project board, list, task panel and settings. /projects/:key opens the board.
  const project = path.match(/^\/projects\/([A-Za-z][A-Za-z0-9]{1,5})(?:\/(board|list|settings)|\/tasks\/(\d{1,9}))?\/?$/);
  if (project) {
    const key = project[1].toUpperCase();
    if (project[2] === "settings") {
      if (role !== "OA") return forbidden("Only Org Admins can change project settings.", `/projects/${key}/board`);
      return <ProjectSettingsPage key={key} projectKey={key} />;
    }
    return <ProjectPage key={key} projectKey={key} view={project[2] === "list" ? "list" : "board"} taskNumber={project[3] ? Number(project[3]) : undefined} />;
  }

  // Workspace home. Any other path falls through to the 404 page.
  if (path === "/onboarding" || path === "/projects") return <OnboardingPage />;
  return undefined;
}

export default function App() {
  return (
    <ToastProvider>
      <AuthProvider>
        <AppProvider>
          <RealtimeProvider>
            <NotificationsProvider>
              <MainApp />
            </NotificationsProvider>
          </RealtimeProvider>
        </AppProvider>
      </AuthProvider>
    </ToastProvider>
  );
}