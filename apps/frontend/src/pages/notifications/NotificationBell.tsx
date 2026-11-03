import { useEffect, useRef, useState } from "react";
import { Bell } from "lucide-react";
import { IconButton, Button } from "../../components";
import { useAuth } from "../../context/AuthContext";
import { useNotifications } from "../../context/NotificationsContext";
import { useApp } from "../../context/AppContext";
import { useClickOutside } from "../../lib/hooks";
import { timeAgo } from "../../lib/format";
import { describeNotification } from "./notificationText";

interface NotificationBellProps {
  // Where "View all" goes: /notifications, or /admin/notifications for SA.
  allPath: string;
}

const badgeCount = (n: number) => (n > 99 ? "99+" : String(n));

export function NotificationBell({ allPath }: NotificationBellProps) {
  const { navigate } = useApp();
  const { user } = useAuth();
  const { unreadCount, latest, open, markAllRead } = useNotifications();
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useClickOutside([containerRef], () => setIsOpen(false), isOpen);
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setIsOpen(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isOpen]);

  const label = unreadCount ? `Notifications (${badgeCount(unreadCount)} unread)` : "Notifications";

  return (
    // Not "relative" on phones: the panel then anchors to the (sticky) header and spans the screen instead of hanging off the bell and running past the left edge.
    <div ref={containerRef} className="inline-flex sm:relative">
      <IconButton label={label} icon={<Bell className="w-4 h-4" />} aria-haspopup="dialog" aria-expanded={isOpen} onClick={() => setIsOpen((o) => !o)} />
      {unreadCount > 0 && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -top-1 -right-1.5 min-w-4 h-4 px-1 flex items-center justify-center bg-brand-600 text-white text-[10px] font-semibold leading-none"
        >
          {badgeCount(unreadCount)}
        </span>
      )}

      {isOpen && (
        <div
          role="dialog"
          aria-label="Latest notifications"
          className="absolute inset-x-2 top-full mt-1.5 sm:inset-x-auto sm:right-0 sm:w-80 sm:max-w-[calc(100vw-2rem)] z-50 bg-white dark:bg-dark-card border border-zinc-200/90 dark:border-zinc-800/90 shadow-xl rounded-none animate-in fade-in zoom-in-95 duration-100"
        >
          <div className="flex items-center justify-between gap-2 px-3.5 py-2.5 border-b border-zinc-100 dark:border-zinc-800/80">
            <span className="text-xs font-semibold text-zinc-950 dark:text-white">Notifications</span>
            <Button variant="quiet" size="sm" disabled={!unreadCount} onClick={markAllRead} className="text-xs">
              Mark all read
            </Button>
          </div>

          {latest.length === 0 ? (
            <p className="px-3.5 py-6 text-center text-xs text-zinc-500 dark:text-zinc-400">You're all caught up.</p>
          ) : (
            <ul className="max-h-96 overflow-y-auto divide-y divide-zinc-100 dark:divide-zinc-800/80">
              {latest.map((n) => {
                const { text, detail } = describeNotification(n, user?.id);
                return (
                  <li key={n.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setIsOpen(false);
                        open(n);
                      }}
                      className="w-full text-left flex gap-2.5 px-3.5 py-2.5 hover:bg-zinc-50 dark:hover:bg-dark-elevated focus-visible:outline-none focus-visible:bg-zinc-100 dark:focus-visible:bg-dark-elevated"
                    >
                      <span
                        aria-label={n.read ? undefined : "Unread"}
                        className={`mt-1.5 w-1.5 h-1.5 shrink-0 ${n.read ? "bg-transparent" : "bg-brand-600"}`}
                      />
                      <span className="min-w-0">
                        <span className={`block text-xs ${n.read ? "text-zinc-600 dark:text-zinc-400" : "text-zinc-900 dark:text-white font-medium"}`}>
                          {text}
                        </span>
                        {detail && <span className="block text-xs text-zinc-500 dark:text-zinc-400 truncate">{detail}</span>}
                        <span className="block text-[11px] text-zinc-400 dark:text-zinc-500 mt-0.5">{timeAgo(n.createdAt)}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="border-t border-zinc-100 dark:border-zinc-800/80 px-3.5 py-2">
            <Button
              variant="quiet"
              size="sm"
              className="text-xs w-full"
              onClick={() => {
                setIsOpen(false);
                navigate(allPath);
              }}
            >
              View all notifications
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}