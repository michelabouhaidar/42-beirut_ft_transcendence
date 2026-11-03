# Trenno - Requirements Specification

## 1. Conventions

- The backend enforces every rule; the frontend only hides what is not allowed.
- All functional and non-functional requirements specified herein are implemented and enforced.
- Anything not written here is out of scope.

---

## 2. Glossary

| Term | Meaning |
|---|---|
| Organization (org) | A team workspace with members and projects. |
| Project | Tasks grouped under a key such as `WEB`. |
| Task | Work item `KEY-n`, e.g. `WEB-12`. |
| Project access | The list of Members/Viewers allowed in a project (OAs always have access). |
| Soft delete | Setting `deleted_at` instead of removing the row (§7.1). |
| SA / OA / M / V / U | System Admin, Org Admin, Member, Viewer, Unaffiliated user. |

---

## 3. Product overview

Trenno is a collaborative task-management web app. Teams work in **organizations → projects → tasks**. Users create and assign tasks on a live Kanban board, comment, get notified, search, and collaborate in real time.

---

## 4. Roles and permissions

### 4.1 Roles

| Role | Description |
|---|---|
| **SA** | Platform admin. Manages all users and orgs. Belongs to no org. First SA created from `.env` by the seed. |
| **OA** | Manages one org: invitations, members, roles, projects, project access. Has access to every project of the org and does all task work. |
| **Member** | Works (tasks, comments) in projects they have access to. |
| **Viewer** | Read-only in projects they have access to, except that they can comment (TSK-11). Can search, have friends, get notifications. |
| **Unaffiliated** | Verified account without org: profile, create an org, accept an invitation. |

Rules:
- A non-SA user belongs to **0 or 1** org.
- An org always has **at least one OA**; any action that would break this is refused (`LAST_ORG_ADMIN`, see §7.6 Refusals).
- Only the SA appoints or demotes an OA, except that the creator of an org becomes its first OA.
- Resource outside the user's scope → **404**. Inside the scope but action not allowed → **403**.

### 4.2 Permission matrix (authoritative)

✓ allowed · ✗ refused · **org** = own org · **proj** = projects with access · **own** = created by them

| Action | SA | OA | M | V | U |
|---|:-:|:-:|:-:|:-:|:-:|
| Own profile, avatar, password, 2FA | ✓ | ✓ | ✓ | ✓ | ✓ |
| View another user's profile | ✓ | org | org | org | ✗ |
| Friends and presence | ✗ | org | org | org | ✗ |
| List / edit / suspend / delete any user; grant SA; appoint/demote OA | ✓ | ✗ | ✗ | ✗ | ✗ |
| Create an org | ✓ | ✗ | ✗ | ✗ | ✓ |
| Edit / delete the org | ✓ | org | ✗ | ✗ | ✗ |
| Invite (Member/Viewer), resend, revoke invitations | ✓ (any role) | org | ✗ | ✗ | ✗ |
| Change role Member ↔ Viewer, remove Member/Viewer | ✓ | org | ✗ | ✗ | ✗ |
| Leave the org | - | ✓ (not last OA) | ✓ | ✓ | - |
| Create / edit / delete project, grant/revoke access | ✓ | org | ✗ | ✗ | ✗ |
| View project, board, tasks, comments; search | ✗ | org | proj | proj | ✗ |
| Create / edit / move / assign task | ✗ | org | proj | ✗ | ✗ |
| Delete task | ✗ | org | own | ✗ | ✗ |
| Add comment / edit own comment | ✗ | org | proj | proj | ✗ |
| Delete comment | ✗ | org | own | own | ✗ |

### 4.3 Different views per role (*Advanced permissions*)

| Role | UI |
|---|---|
| SA | **Admin** menu: Users, Organizations. Can open any org and manage its projects, but never sees its tasks or comments (data confidentiality). |
| OA | **Organization** menu: Members, Invitations, Settings. "New project", project settings and access. |
| M | Task create/edit, drag and drop. No org admin menu. |
| V | Same pages as M in **read-only** mode (no create/edit/drag, "Read-only" badge). |
| U | Onboarding page: "Create an organization" + pending invitations. |

---

## 5. Scope

**In:** sign-up with email verification, login, lockout, logout, password reset and change, TOTP 2FA · invitations by email · profiles, avatars, friends, presence · admin panel · orgs, members, roles · projects with access list · tasks, Kanban, list view, comments, live updates · notifications (in-app + security emails) · search · custom design system & component showcase · real-time WebSockets · Prometheus and Grafana monitoring · legal pages · soft delete · HTTPS · Docker · email over SMTP.

**Out:** analytics dashboard, data import/export, archive/restore, Project Owner, membership suspension, task links, task history, audit log, session list, OAuth, chat, file attachments, PWA, SSR.

---

## 6. Functional requirements

### 6.1 Accounts (AUTH) - *mandatory + Standard user management*

| ID | Requirement | Acceptance criteria |
|---|---|---|
| **AUTH-01** | Sign-up. | First name, last name, email, password + confirmation, accept Terms/Privacy (links to both pages). Account created `PENDING_VERIFICATION`; page says "check your email". An email already in use gets the **same** message **and the same HTTP status** (no enumeration) and no new account. |
| **AUTH-02** | Email verification. | Email with a single-use link valid 24 h. Valid link → `ACTIVE`, redirect to login. Expired/used link → error page with "Resend email" (rate-limited). |
| **AUTH-03** | Login / logout. | Email + password. Wrong credentials → "Invalid email or password". Unverified → "Verify your email first" + resend. Suspended → "Account suspended". Logout deletes the session and closes that session's sockets. |
| **AUTH-04** | Lockout. | 5 consecutive failures → locked 15 min ("Try again in N minutes") + email to the user. Success resets the counter, and so does an expired lock (one wrong attempt after it starts a new count). Plus 10 attempts/min per IP. |
| **AUTH-05** | Forgot password. | Always answers "If an account exists, a link was sent". Link single-use, valid 30 min; new request invalidates older links. On reset: all sessions revoked, lockout reset, confirmation email. |
| **AUTH-06** | Change password. | Current password required. Other sessions revoked. Confirmation email. |
| **AUTH-07** | Sessions. | Server-side sessions in PostgreSQL; cookie `HttpOnly; Secure; SameSite=Lax`; idle timeout 12 h, absolute 7 days. Expired → redirect to login and back to the same page after login (any 401 from the API while signed in ends the client session and triggers the same redirect, so it also works when the session expires while a page is open). Suspension/deletion revokes all sessions and closes sockets immediately. |

### 6.2 Two-factor authentication (2FA) - *Minor: complete 2FA*

| ID | Requirement | Acceptance criteria |
|---|---|---|
| **2FA-01** | Enable TOTP. | *Settings → Security*: password required, QR code generated locally + secret as text. Active only after a valid 6-digit code. Secret stored encrypted (AES-256-GCM, key in `.env`). |
| **2FA-02** | Recovery codes. | 10 single-use codes, shown once (copy / download .txt), stored hashed. |
| **2FA-03** | Login second step. | After the password, a 5-minute pending step accepts a TOTP (±1 step) or a recovery code. 5 wrong codes → start again. |
| **2FA-04** | Disable. | Password + valid code. Confirmation email. |

### 6.3 Invitations (INV) - *Organization system*

| ID | Requirement | Acceptance criteria |
|---|---|---|
| **INV-01** | Invite by email. | OA: Member or Viewer into their org. SA: any role, any org. One pending invitation per (org, email). Inviting a current member is refused. The invitee receives an email with a single-use link valid 7 days. |
| **INV-02** | Accept as a new person. | Link → setup page with org and role shown, email pre-filled read-only; enter names, password, accept Terms. Account created `ACTIVE` (email proven), membership created, user logged in. |
| **INV-03** | Accept as an existing account. | Must be logged in as the invited email. Accept / Decline. If already in another org → "Leave <org> first". Pending invitations also appear on the Unaffiliated onboarding page. |
| **INV-04** | Manage invitations. | OA/SA list: email, role, inviter, expiry, status. **Resend** (new token, old link dead) and **Revoke**. Expired, revoked, used or replaced links → clear error page (API refusal with the link's state as `code`, §7.6). |

### 6.4 Profiles, friends, presence (USR) - *Standard user management*

| ID | Requirement | Acceptance criteria |
|---|---|---|
| **USR-01** | Edit own profile. | First/last name, job title (≤ 100), bio (≤ 500). Name changes show everywhere immediately. |
| **USR-02** | Avatar. | Upload JPEG/PNG/WebP ≤ 2 MB, checked by file signature; re-encoded to 256×256 WebP with `sharp`; random file name on the `uploads` volume; served only to logged-in users. Remove → default avatar (initials on a color from the user id). Refused: other types or fake extensions (415), corrupt image (422), over 2 MB (413). The previous file is deleted on replace, remove and account deletion. nginx allows 3 MB request bodies on `/api/`. |
| **USR-03** | Profile page. | `/users/:id`: avatar, name, job title, bio, org, role, member since, presence (friends only), friend button. Visible to the user, same-org members and System Admins; anyone else gets 404. Never shows email or credentials. |
| **USR-04** | Member directory. | *Organization → Members* (`/org/members`, every org role): avatar, name, job title, role; text filter on name and job title; pagination (20 per page, max 50); sorted by last name. Each row links to the profile and carries the friend button. |
| **USR-05** | Friends. | Same-org users can send a request; the other accepts or declines; either can remove. Refused: self, duplicates, other org. Friendships end when a user leaves the org, is deleted, or becomes a System Admin. Pending requests end the same way. After a decline or cancel a new request can be sent. System Admins and unaffiliated users have no friends feature. Two simultaneous requests create one. `/friends` has Friends, Incoming and Outgoing tabs. Live: every request, accept, decline, cancel and removal (and friendships ended by leaving, deletion or System Admin promotion) sends `friendship:updated` to both people's `user:<id>` rooms; the Friends, Members and profile pages refresh at once. |
| **USR-06** | Online status. | Friends list shows **Online** or **Offline** ("last seen …"). Online = at least one open socket; offline only after a 10 s grace period with none, so a reload or a short network drop doesn't flicker. Going offline stores `last_seen_at`. Shown on the friends list and on a friend's profile, never to non-friends; changes are pushed live (`presence:update` to each friend's user room). |

### 6.5 Administration (ADM) - *Advanced permissions*

| ID | Requirement | Acceptance criteria |
|---|---|---|
| **ADM-01** | SA seed. | `SEED_SA_EMAIL` / `SEED_SA_PASSWORD` from `.env` on first start; idempotent. |
| **ADM-02** | Create users. | Through an invitation (INV-01), including an invitation to become SA. The SA invitation is a single-use link (`/sa-invite/:token`, 7 days, stored in `sa_invitation`) that creates an active System Admin with no organization and signs them in. A new invitation to the same address cancels the earlier link. Refused for an address that already has an account (the SA role is granted from the user page). |
| **ADM-03** | List and view users. | Table: name, email, status, org, role, 2FA on/off, last login. Search by name/email, filter by status/org, sort, pagination. |
| **ADM-04** | Edit users. | Names, job title (≤ 100), bio (≤ 500); over-long values are refused with 400. Role changes: grant/revoke SA, appoint OA / demote OA to Member (last-SA and last-OA rules apply). User notified. |
| **ADM-05** | Suspend / reactivate. | Sessions revoked and sockets closed immediately; email to the user. Not on self or last SA. |
| **ADM-06** | Delete users. | Typed email confirmation. Soft delete with anonymization (§7.1). Refused for the last OA of an org or the last SA. Email sent before anonymization. |
| **ADM-07** | Role-based UI. | Every role sees exactly §4.3. Typing a forbidden URL shows 403/404; API returns 403/404. |

### 6.6 Organizations (ORG) - *Organization system*

| ID | Requirement | Acceptance criteria |
|---|---|---|
| **ORG-01** | Create an org. | Unaffiliated user (becomes OA in the same transaction) or SA (then invites the first OA). Name 2–100 unique, description ≤ 1,000. A user who already belongs to an organization is refused (`ALREADY_IN_ORG`, §7.6); names are compared case-insensitively among live orgs. |
| **ORG-02** | View orgs. | SA: admin list (name, members, projects, created) + detail. Others: overview of their org. |
| **ORG-03** | Edit an org. | OA or SA. `PATCH /orgs/:id` (OA of that org, or SA); another org's OA or a Member gets 404. Settings page at `/org/settings`. |
| **ORG-04** | Delete an org. | OA or SA; typed name. Soft-deletes the org and its projects, tasks, comments, access rows; revokes pending invitations; ends memberships and friendships between its members. Members become unaffiliated and receive an email. The name can be reused. `DELETE /orgs/:id` with `confirmName`; the dialog lists what happens before confirming. |
| **ORG-05** | Add users. | Through invitations (§6.3). |
| **ORG-06** | Change role Member ↔ Viewer. | OA or SA. Becoming Viewer unassigns their tasks (warning shows how many). Affected user's UI changes live. `PATCH /orgs/:id/members/:userId` with `role`; `GET …/impact` returns the task count shown in the warning. Org Admin roles and your own role can't be changed here. The user gets an email. |
| **ORG-07** | Remove a member / leave. | OA removes Members/Viewers (SA can remove anyone); anyone can leave except the last OA. Membership ended (`left_at`), project access revoked, tasks unassigned, friendships ended, email sent to a removed user. Their tasks/comments remain. `DELETE /orgs/:id/members/:userId` (an OA cannot remove an OA; never the last OA) and `POST /orgs/:id/leave`. Leaving sends no email. Buttons are on the Members page. |

### 6.7 Projects (PRJ) - *Organization system*

| ID | Requirement | Acceptance criteria |
|---|---|---|
| **PRJ-01** | Create a project. | OA/SA. Name 2–100 (unique in org), key `^[A-Z][A-Z0-9]{1,5}$` (unique, immutable), description ≤ 2,000, optional start/target dates. Name is compared case-insensitively, key and name are unique among the org's live projects, and the target date can't be before the start date. `POST /projects`; a System Admin passes `orgId` (and from the admin organization page). |
| **PRJ-02** | Project list. | OA: all org projects. M/V: projects with access. Each card: name, key, % Done, open and overdue counts. Overdue = not Done with a due date before today. `GET /projects` (SA: `?orgId=`); a project a user can't see is a 404. |
| **PRJ-03** | Edit a project. | OA/SA. Key cannot change. `PATCH /projects/:key`; a different `key` is refused with `KEY_IMMUTABLE`. Settings page at `/projects/:key/settings`. |
| **PRJ-04** | Project access. | OA grants/revokes access to Members/Viewers of the org. Revoking unassigns that user's tasks in the project and removes them from the project's live room. `GET/POST /projects/:key/access`, `DELETE /projects/:key/access/:userId`; Org Admins are listed as always having access; the revoke dialog shows how many tasks get unassigned. A revoked user's sockets leave `project:<id>` at once and get `me:updated`, so their open board refetches and shows the 404; any later request is refused too. |
| **PRJ-05** | Delete a project. | OA/SA; typed key. Soft-deletes the project, tasks, comments, access rows. Open boards show "This project was deleted". Name/key reusable. `DELETE /projects/:key` with `confirmKey`; afterwards the key answers the refusal `PROJECT_DELETED` (§7.6) to anyone who could see it. Open boards get `project:deleted` and show it at once; the project room is closed. |

### 6.8 Tasks, board, comments (TSK) - *Organization system*

| ID | Requirement | Acceptance criteria |
|---|---|---|
| **TSK-01** | Create a task. | Title 1–200, description ≤ 10,000 (plain text), status (default To Do), priority (default Medium), due date, assignee. Creator set automatically. Number `KEY-n` allocated atomically (§7.3), never reused. `POST /projects/:key/tasks`. Unknown fields are refused (400). Due date `YYYY-MM-DD`, 2000–2100. |
| **TSK-02** | Values. | Status: **To Do, In Progress, Done** (Done sets `completed_at`, leaving Done clears it). Priority: **Low, Medium, High, Urgent**. Other values → 400. |
| **TSK-03** | Assignee. | Zero or one. Must be an active OA or Member with access to the project. Assign/reassign/unassign; previous and new assignee notified. `GET /projects/:key/assignees` lists who can be assigned. A change creates one `task.assigned` notification for the creator, the new and the previous assignee (never the actor); the text depends on the reader ("assigned to you", "reassigned to …", "unassigned you"). |
| **TSK-04** | Edit a task. | All fields from the detail panel. Version check (§7.2). `PATCH /projects/:key/tasks/:n` with `version`; a stale version gets the refusal `VERSION_CONFLICT` (§7.6) with the current task, and the panel shows it with a toast. |
| **TSK-05** | Kanban board. | 3 columns with counts; cards show key, title, priority badge, due date (red if overdue), assignee avatar. Filters: text, assignee (incl. me/unassigned), priority. Horizontal scroll on small screens. `/projects/:key/board`. "+" on each column creates a task in it. |
| **TSK-06** | Drag and drop. | dnd-kit, between and within columns; status and position saved. Each card also has a "Move to…" menu (keyboard alternative). Viewers cannot drag. `POST /projects/:key/tasks/:n/move` with `status`, `index` and `version`. The "Move to…" menu is the design system's `Menu` component. |
| **TSK-07** | Live updates. | Create, edit, move, assign, delete and comments appear on other open boards/panels within 2 s without reload. The board joins `project:<id>` (`project:join`, access checked) and refetches when a `task:*`, `comment:*`, `member:updated` or `me:updated` event arrives (batched per 100 ms). A `task:updated` whose `version` the client already has is ignored; a typed-but-unsaved panel draft is kept. |
| **TSK-08** | List view. | Sortable table of the project's tasks. `/projects/:key/list`: sort by key, title, status, priority, assignee, due, updated. |
| **TSK-09** | Detail panel. | Opened from the board or by URL `/projects/:key/tasks/:n`. All fields, creator, dates, comments. Read-only for Viewers. Viewers see fields read-only but can comment (TSK-11). |
| **TSK-10** | Delete a task. | OA, or the Member who created it. Confirmation. Soft delete with its comments. `DELETE /projects/:key/tasks/:n`. |
| **TSK-11** | Comments. | OA, Members **and Viewers** with access: add (1–5,000 chars), edit own ("edited"), delete own (OA: any). Deleted comments show "This comment was deleted". Live for other viewers. `GET/POST /projects/:key/tasks/:n/comments`, `PATCH/DELETE /comments/:id`. |

### 6.9 Notifications (NOTIF) - *Minor: complete notification system*

**Rule:** Every create, update, or delete action listed below creates a persistent notification for each user in the audience, **except the actor**, and only if the user can still access the resource. Text is stored as `type + params` and rendered by the frontend, so wording can change without touching stored rows.

| Resource | Events | Audience |
|---|---|---|
| Account | password changed/reset, 2FA on/off, locked, suspended/reactivated, edited or role changed by SA | the user |
| Invitation | created/resent, revoked | invitee (if they have an account) |
| Invitation | accepted / declined | inviter + OAs |
| Organization | edited, deleted | all members |
| Membership | joined, role changed, removed/left | the user + OAs |
| Project | created, edited, deleted | users with access |
| Project access | granted, revoked | the user |
| Task | created, edited, moved, (re)assigned, deleted | creator + assignee + previous assignee |
| Comment | added, edited, deleted | creator + assignee + commenters of the task (deleted: the author) |
| Friendship | request received, request accepted | the other user |

**Also sent by email:** verification, password reset, password changed, account locked, 2FA disabled, account suspended/deleted, invitation, removed from org, org deleted.

**Application rules:**
- **No actor.** Lockout and changes to one's own password or 2FA have no actor (`actor_id` is null), so the user is always notified, even when they performed the change.
- **Access.** Task and comment audiences are strictly filtered to users who currently have access to open the project (an active OA of the org, or an active access row). For a deleted project or organization, the audience is resolved *before* deletion.
- **One notification per action.** An accepted invitation generates one `invitation.accepted` to the inviter and the OAs. A task edit changing only the column produces `task.moved`; other field changes produce `task.updated`. Reassignment produces `task.assigned`. An edit with no changes emits no notifications.
- **Excluded actions.** Reordering within a single column, declining a friend request, and comments deleted by their own author do not create a notification. Deleted accounts receive no notifications.
- **Suspended accounts.** `account.suspended` remains in the inbox and is visible upon reactivation.

**Event types:**

| Resource (`resource_type`) | Types |
|---|---|
| Account (`user`) | `account.password_changed`, `account.password_reset`, `account.2fa_enabled`, `account.2fa_disabled`, `account.locked`, `account.suspended`, `account.reactivated`, `account.updated`, `account.role_changed` |
| Invitation (`invitation`) | `invitation.received` (`resent: true` on a resend), `invitation.revoked`, `invitation.accepted`, `invitation.declined` |
| Organization (`organization`) | `org.updated`, `org.deleted` |
| Membership (`membership`) | `membership.role_changed`, `membership.removed`, `membership.left` |
| Project / access (`project`) | `project.created`, `project.updated`, `project.deleted`, `project.access_granted`, `project.access_revoked` |
| Task (`task`) | `task.created`, `task.updated`, `task.moved`, `task.assigned`, `task.deleted` |
| Comment (`comment`) | `comment.created`, `comment.updated`, `comment.deleted` |
| Friendship (`friendship`) | `friend.request_received`, `friend.request_accepted` |

**Target navigation:** A task or comment notification routes to `/projects/:key/tasks/:n`; a project routes to its board; an organization routes to `/org/settings` (OA) or `/projects`; a membership routes to `/org/members` (OA) or `/projects`; an invitation routes to `/onboarding` (invitee, while pending) or `/org/invitations` (OA); a friendship routes to `/friends` (pending) or the friend's profile; a System Admin routes to `/admin/orgs/:id`. Account security notifications do not open a resource.

| ID | Requirement | Acceptance criteria |
|---|---|---|
| **NOTIF-01** | Generation. | A centralized backend helper `notify(event, resource, actor)` resolves the audience according to the matrix above; called across all domain services. |
| **NOTIF-02** | Real-time bell. | Header bell icon present in every header (workspace, onboarding, admin). Unread badge count (99+) updates in real time via Socket.IO (`notification:new`, and `notification:sync` when another tab reads or deletes); also refetched upon reconnection and visibility change. Dropdown shows latest 10 items with "Mark all read"; item click marks as read and navigates to target resource. |
| **NOTIF-03** | Notification page. | Dedicated `/notifications` view (System Admin: `/admin/notifications`; available also to unaffiliated users for invitation notices): All / Unread filter tabs, pagination (20 items/page). Features: Mark read, mark all read, delete (soft delete). |
| **NOTIF-04** | Missing resource handling. | Clicking a notification whose underlying resource was deleted or made inaccessible displays a clear message: "This item was deleted or you no longer have access to it." Managed by backend response `PATCH /notifications/:id/read` returning `{ gone: true }`. |

### 6.10 Search (SRCH) - *Minor: advanced search*

| ID | Requirement | Acceptance criteria |
|---|---|---|
| **SRCH-01** | Scope-aware search. | Text matching (case-insensitive, partial) across task key, title, and description backed by `pg_trgm` GIN index. Never returns tasks outside user's authorized scope. Header search bar routes directly to `/search?q=`. `GET /search/tasks?q=` performs scoped matching; OA search the whole org; Members/Viewers search only projects with access. |
| **SRCH-02** | Multi-attribute filters. | Filter by project, status, priority, assignee (`me`, `unassigned`, or user ID), and due date range (`dueFrom`, `dueTo`). Removable filter chips + "Clear all". Parameters accept comma-separated multi-values; invalid parameters return 400. Response provides available projects and assignees for quick filtering. |
| **SRCH-03** | Sorting options. | Sort by updated date (default), created date, due date (empty dates placed last), priority, or title; direction `asc` or `desc`. Defaults: newest updated first, soonest due first, highest priority first, alphabetical title A→Z. |
| **SRCH-04** | Pagination & URL sync. | 25 results per page with range indicator (e.g., "26–50 of 132"). Search query, applied filters, sort field, direction, and page number synchronize with URL query parameters for shareable URLs and functional browser history. |

### 6.11 Custom design system (DS) - *Minor: custom design system / UI kit*

| ID | Requirement | Acceptance criteria |
|---|---|---|
| **DS-01** | Design tokens & theme. | Consistent design tokens (color palette, typography scales, spacing, border radiuses, shadow elevations) configured via Tailwind and CSS variables. Seamless dark and light mode support with proper contrast ratios. |
| **DS-02** | Iconography. | Cohesive icon set (Lucide icons) integrated across all components, navigation, buttons, and status indicators with uniform sizing and alignment. |
| **DS-03** | Reusable UI components. | Modular library of ≥ 10 reusable UI components (Button, IconButton, Input, Textarea, Select, Checkbox, Card, Badge, Alert, Toast, Modal, ConfirmDialog, Menu, Tabs, Spinner, Avatar, Logo, ThemeToggle, PasswordChecklist, EmptyState) with defined variants, props, and keyboard/focus accessibility states. |
| **DS-04** | Live component showcase. | Dedicated showcase view at `/design-system` demonstrating all design tokens, component variants, interactive states (hover, focus, disabled, active), and real-time theme toggling. |

### 6.12 Real-time (RT) - *Major: real-time features using WebSockets*

| ID | Requirement | Acceptance criteria |
|---|---|---|
| **RT-01** | Authenticated connection. | Socket.IO over WSS via nginx reverse proxy. Handshake verifies session cookie; missing or invalid session connection is rejected. User logout, account suspension, or deletion terminates active sockets immediately. |
| **RT-02** | Real-time updates. | Changes to the Kanban board, task panels, comments (TSK-07), online presence (USR-06), notifications (NOTIF-02), and role/access changes (`me:updated`) propagate to other active clients within 2 seconds without full-page reloads. |
| **RT-03** | Scoped room broadcasting. | Partitioned rooms: `user:<id>`, `org:<id>`, and `project:<id>`. Events emit strictly to the targeted room. Clients subscribe to/unsubscribe from `project:<id>` when opening or closing a board; backend verifies project access on subscription. |
| **RT-04** | Graceful reconnects & versioning. | Network disconnection triggers a visible "Reconnecting…" banner (GEN-04). Automatic reconnection with exponential backoff rejoins active rooms and refetches stale state. Presence reflects offline status after a 10 s grace period. State events carry optimistic `version` counters to prevent out-of-order race conditions (§7.2). |

### 6.13 General and legal (GEN) - *mandatory*

| ID | Requirement | Acceptance criteria |
|---|---|---|
| **GEN-01** | Legal pages. | Publicly accessible `/privacy` and `/terms` linked in the global footer of every page, detailing stored user data, transactional emails, cookie usage, soft deletion policies, retention, and service usage terms. |
| **GEN-02** | User feedback & errors. | Inline field validation errors; action toasts; 401 triggers login redirect; dedicated 403 Forbidden page; 404 Not Found page; conflict notifications (`VERSION_CONFLICT` refusal) with automatic re-fetch; rate limit banner (`RATE_LIMITED` refusal) ("Try again in N s"); 5xx generic error messages without exposing stack traces. |
| **GEN-03** | Action confirmations. | Confirmation dialogs on destructive actions; explicit typed string confirmation for deleting users, organizations, or projects. |
| **GEN-04** | Connection banner. | When WebSocket connection drops, a "Reconnecting…" status banner appears; upon reconnect, current view state automatically refreshes. |
| **GEN-05** | Demo seed. | `make seed-demo` script creates: 1 SA, 1 org, 1 OA, 2 Members, 1 Viewer, 2 projects, ~60 sample tasks spanning 60 days, comments, and established friendships. Default credentials documented in README. |
| **GEN-06** | Landing page and dark mode. | Polished landing page with direct call-to-actions and a global theme toggle supporting persistent dark and light modes. |

---

## 7. Business rules

### 7.1 Soft delete
- Business data is **never** removed with a raw `DELETE` query. Delete operations set `deleted_at` (along with `deleted_by_id`).
- A Prisma client extension automatically adds `deleted_at IS NULL` to read queries of soft-deletable models.
- Soft-deleted resources behave as missing resources: returning **404 Not Found**.
- Unique constraints (such as organization names and project keys) use partial unique indexes `WHERE deleted_at IS NULL`, allowing reuse of identifiers once original entities are soft-deleted.
- Cascading deletions occur within a single database transaction (org → projects → tasks → comments; project → tasks → comments + access; task → comments).
- **User deletion equates to anonymization:** names set to "Deleted user", email set to `deleted-<uuid>@invalid`, bio/job/avatar/password hash/2FA records erased, active sessions and tokens revoked, memberships terminated, friendships removed, assigned tasks unassigned, and `status` set to `DELETED`. Existing authored tasks and comments retain attribution to "Deleted user".
- No user-facing undelete functionality is provided.

### 7.2 Concurrency
- Tasks maintain an integer `version` field. Update and move requests transmit the version; `UPDATE … WHERE id = ? AND version = ?` atomically increments the version.
- If 0 rows match, the API returns the `VERSION_CONFLICT` refusal (§7.6) alongside current task data; the UI alerts the user ("This task was just changed by <name>") and refreshes, snapping dragged cards back to actual state.
- Card vertical ordering utilizes a floating-point `position` attribute; moving between cards assigns the midpoint between neighbors. The column is renumbered in a single transaction if positional gaps shrink below threshold.
- Database invariants: unique active membership per user, unique friendship pair, unique project key, unique org name (using partial indexes). "At least one OA / SA" invariant validated inside transactions.
- WebSocket events transmit `version` attributes; clients discard events older than their local state version.

### 7.3 Task numbers
- Atomic incremental sequence per project: `UPDATE project SET task_counter = task_counter + 1 … RETURNING` executed in the same transaction as task creation.

### 7.4 Account status
- Workflow: `PENDING_VERIFICATION` → `ACTIVE` ↔ `SUSPENDED`; `DELETED` is irreversible.
- Account lockout is managed via a `locked_until` timestamp attribute, not a categorical status.

### 7.5 Limits

| Item | Value |
|---|---|
| Lockout | 5 failures → 15 min |
| Login rate limit | 10 / min per IP |
| Verification link / reset link / invitation | 24 h / 30 min / 7 days, single-use, stored as SHA-256 hash |
| Resend verification / reset | 3 per email per hour |
| 2FA pending step | 5 min, 5 attempts |
| Session | idle 12 h, absolute 7 days |
| API rate limit | 300 / min per user |
| Avatar | JPEG/PNG/WebP ≤ 2 MB |

### 7.6 Validation (Zod schemas in `apps/backend/src/schemas.ts`)

| Field | Rule |
|---|---|
| Email | trimmed, lower-cased, valid email format, ≤ 254 chars |
| Password | 8–128 chars, uppercase + lowercase + digit + special character; live checklist on UI |
| Names | 1–50 chars, letters (any script), space, `'`, `-` |
| Org / project name | 2–100 chars |
| Project key | `^[A-Z][A-Z0-9]{1,5}$` |
| Task title / description | 1–200 / ≤ 10,000 chars |
| Comment | 1–5,000 chars |
| Dates | `YYYY-MM-DD`, valid dates between 2000 and 2100 |
| Unknown body fields | rejected (`VALIDATION_ERROR` refusal) |

**Refusals and errors.** A valid request that the current state refuses is an answer, not an error: the API replies `200` with `{ "ok": false, "error": { "code", "message" } }`. This covers input the rules reject (`VALIDATION_ERROR` with the rule's message, e.g. the password policy, which the form then shows), wrong credentials, a locked, suspended or unverified account, a wrong 2FA code or current password, an expired 2FA step, a used, expired or replaced email link or invitation, a name or key already taken, a stale task version (`VERSION_CONFLICT`, with the current `task`), a deleted project (`PROJECT_DELETED`), an action another admin already took (`ALREADY_SUSPENDED`, …), last-admin rules, a rejected avatar file, rate limits, and something that is not (or no longer) there or allowed — access revoked, a task, comment, member, org or notification deleted, a stale link or bookmark (`NOT_FOUND`, `FORBIDDEN`; still a 404 page in the UI). Internally these are the 403/404/409/410/413/415/422/423/429 cases. Faults keep real status codes: `400` a body that isn't valid JSON, `401` no or expired session (it also signs the client out), `404` an API route that doesn't exist, `405` wrong method, `500` server error. `GET /auth/me` answers `200` with `user: null` when nobody is signed in. Result: the browser console stays clean in normal use; a red line always means a real fault.

### 7.7 Security
- Passwords hashed with salted Argon2id.
- Server-side session cookies: `HttpOnly; Secure; SameSite=Lax`.
- Multi-tier route authorization on every endpoint: Authentication → Organization scope → Project access → Role permissions.
- Security headers enforced by nginx reverse proxy (HSTS, CSP, X-Content-Type-Options: nosniff, X-Frame-Options: DENY, Referrer-Policy).
- React automatic escaping utilized exclusively; no `dangerouslySetInnerHTML`.
- Database access parameterized through Prisma ORM; raw SQL strictly isolated via `Prisma.sql`.
- Application logs redact sensitive credentials, tokens, session cookies, and TOTP secrets.

---

## 8. Non-functional requirements (mandatory part)

| ID | Requirement (subject page) | How |
|---|---|---|
| **NFR-01** | Frontend + backend + database (p. 8) | React SPA, Express API, PostgreSQL 17. |
| **NFR-02** | One-command Docker deployment (p. 8) | `make` → `docker compose up --build -d`; migrations + SA seed run at startup. |
| **NFR-03** | Latest Chrome, no console warnings/errors (p. 8) | Checked on every page before evaluation. |
| **NFR-04** | Legal pages (p. 8) | GEN-01 (/privacy and /terms). |
| **NFR-05** | Multi-user, concurrent, real-time, no corruption (p. 8) | Server-side sessions, Socket.IO rooms, optimistic concurrency (§7.2). |
| **NFR-06** | Responsive, accessible frontend, CSS framework (p. 9) | Tailwind CSS; viewport 360–1920 px; input labels; keyboard navigation; visible focus; "Move to…" keyboard alternative to drag-and-drop. |
| **NFR-07** | `.env` ignored, `.env.example` provided (p. 9) | `.env` excluded in `.gitignore`, documented `.env.example` provided. |
| **NFR-08** | Clear schema and relations (p. 9) | Prisma schema, normalized relations, ERD documentation. |
| **NFR-09** | Secure sign-up/login, hashed + salted (p. 9) | Argon2id password hashing, email verification, account lockout (§6.1, §7.7). |
| **NFR-10** | Validation front **and** back (p. 9) | Shared Zod schemas enforcing input constraints on frontend and backend (§7.6). |
| **NFR-11** | HTTPS for every connection to the backend (p. 9) | nginx TLS termination on port 8443, WSS. Only nginx exposes host ports exclusively over HTTPS. |
| **NFR-12** | Git: all members, clear commits (p. 8) | Structured feature branches, pull requests, clear commit messages across team members. |
| **NFR-13** | Offline evaluation | Fonts, icons, and client libraries bundled locally. Outgoing email uses the SMTP server set in `.env`. |

---

## 9. Modules (17 points claimed)

The project implements **11 modules** (6 Major + 5 Minor) for a total of **17 points** (subject minimum: 14 points).

| # | Module | Category | Type | Pts | Requirements |
|---|---|---|---|--:|---|
| 1 | Framework for frontend and backend (React + Express) | Web | Major | 2 | NFR-01 |
| 2 | Standard user management and authentication | User Management | Major | 2 | AUTH-01…07, USR-01…06 |
| 3 | Advanced permissions system | User Management | Major | 2 | §4, ADM-01…07 |
| 4 | Organization system | User Management | Major | 2 | ORG-01…07, INV-01…04, PRJ-01…05, TSK-01…11 |
| 5 | Real-time features using WebSockets | Web | Major | 2 | RT-01…04 |
| 6 | Monitoring system with Prometheus and Grafana | DevOps | Major | 2 | OPS-M1…M5 |
| 7 | ORM (Prisma) | Web | Minor | 1 | §10 |
| 8 | Complete notification system | Web | Minor | 1 | NOTIF-01…04, §6.9 |
| 9 | Advanced search (filters, sorting, pagination) | Web | Minor | 1 | SRCH-01…04 |
| 10 | Complete 2FA system | Cybersecurity | Minor | 1 | 2FA-01…04 |
| 11 | Designing a custom design system / UI kit | Web | Minor | 1 | DS-01…04, §6.11 |
| | **Total** | | **6 Major + 5 Minor** | **17** | |

### 9.1 Subject bullets → requirements mapping

| Module | Subject bullet | Where |
|---|---|---|
| Framework | Frontend framework (React) + backend framework (Express) | NFR-01 |
| Standard user mgmt | Update profile / avatar with default / friends + online status / profile page | USR-01 / USR-02 / USR-05, USR-06 / USR-03 |
| Advanced permissions | Users CRUD / roles management / different views per role | ADM-02…06 / ADM-04, ORG-06 / §4.3, ADM-07 |
| Organization system | Create, edit, delete / add users / remove users / act inside (create, read, update) | ORG-01, 03, 04 / INV-* / ORG-07 / PRJ-*, TSK-* |
| WebSockets | Real-time updates across clients / handle connection and disconnection gracefully / efficient message broadcasting | RT-01…04, GEN-04 |
| Monitoring | Prometheus collects metrics / exporters and integrations / Grafana dashboards / alerting rules / secure access to Grafana | OPS-M1…M5 |
| ORM | Use an ORM for the database (Prisma) | §10 |
| Notifications | All create, update, delete actions | §6.9 table, NOTIF-01…04 |
| Search | Filters / sorting / pagination | SRCH-01…04 |
| 2FA | Complete 2FA (TOTP, QR code, recovery codes) | 2FA-01…04 |
| Design System | Fixed colors, fonts, icons, ≥ 10 reusable components, live showcase | DS-01…04, §6.11 |

### 9.2 Monitoring with Prometheus and Grafana (OPS-M)

Adds 3 dedicated containers: `prometheus`, `grafana`, `postgres-exporter`. Only nginx publishes host ports; Grafana is served securely at `https://localhost:8443/grafana/`.

| ID | Requirement | Acceptance criteria |
|---|---|---|
| **OPS-M1** | Prometheus collects metrics. | Backend exposes `/metrics` with `prom-client` on the internal Docker network only (not proxied by nginx): default Node runtime metrics, HTTP requests by route and status, request duration histogram, and connected WebSocket clients. Scrape interval 15 s; retention 7 days. |
| **OPS-M2** | Exporters. | `postgres-exporter` container collects PostgreSQL metrics (active connections, database size, transactions). Targets configured and healthy (`UP`) in Prometheus. |
| **OPS-M3** | Grafana dashboards. | Datasource and production dashboard provisioned automatically from files in `monitoring/grafana/` (zero manual UI configuration): requests per second, HTTP 5xx error rate, p95 latency, WebSocket active clients, DB connection pool, DB size, and backend CPU/memory usage. |
| **OPS-M4** | Alerting rules. | Pre-configured alerts in `monitoring/prometheus/alerts.yml`: backend service down for 1 min, HTTP 5xx rate > 5% for 5 min, p95 latency > 1 s for 5 min, and database unreachable. Alerts visible in Prometheus and Grafana alert managers. |
| **OPS-M5** | Secure access. | Grafana routed behind nginx over HTTPS; admin authentication configured from `.env`; anonymous access and public sign-ups disabled. Prometheus interface not directly exposed to the host network. |

---

## 10. Data model

PostgreSQL 17 + Prisma. UUID primary keys, `created_at`/`updated_at` timestamps on all models, `citext` for emails and case-insensitive unique names. Soft-deletable tables maintain `deleted_at` + `deleted_by_id`.

| Table | Main fields | Notes |
|---|---|---|
| `user` | email, first_name, last_name, job_title, bio, avatar_path, password_hash, is_system_admin, status, failed_login_count, locked_until, last_login_at, last_seen_at | soft delete = anonymization |
| `auth_token` | user_id, type (`VERIFY_EMAIL`/`RESET_PASSWORD`), token_hash, expires_at, used_at | single-use tokens |
| `session` | id_hash, user_id, pending_2fa, expires_at, last_activity_at, revoked_at | server-side session store |
| `two_factor` | user_id, secret_encrypted, enabled_at | AES-256-GCM encrypted secret |
| `recovery_code` | user_id, code_hash, used_at | single-use hashed recovery codes |
| `organization` | name, description, created_by_id | soft delete; partial unique index on name |
| `membership` | org_id, user_id, role (`OA`/`MEMBER`/`VIEWER`), status (`ACTIVE`/`REMOVED`), joined_at, left_at | partial unique index on user_id where ACTIVE |
| `invitation` | org_id, email, role, invited_by_id, token_hash, status (`PENDING`/`ACCEPTED`/`DECLINED`/`REVOKED`), expires_at | partial unique index on (org_id, email) where PENDING |
| `friendship` | requester_id, addressee_id, status (`PENDING`/`ACCEPTED`/`DECLINED`/`REMOVED`) | partial unique pair where PENDING/ACCEPTED |
| `project` | org_id, key, name, description, start_date, target_date, task_counter | soft delete; partial unique indexes on (org_id, key) and (org_id, name) |
| `project_access` | project_id, user_id, granted_by_id, revoked_at | partial unique index on (project_id, user_id) where revoked_at IS NULL |
| `task` | project_id, number, title, description, status, priority, due_date, assignee_id, creator_id, position, version, completed_at | soft delete; unique (project_id, number); trigram GIN indexes on title and description |
| `comment` | task_id, author_id, body, edited_at | soft delete (body cleared on deletion) |
| `notification` | user_id, actor_id (null for system events), type, params (JSON), resource_type, resource_id, read_at | soft delete; composite index on (user_id, read_at, created_at DESC) |
