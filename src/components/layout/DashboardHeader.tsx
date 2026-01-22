'use client';

import { useAuth } from "@/lib/hooks/useAuth";
import Link from "next/link";
import { Bell, BookOpen, Globe, LogOut, Palette, Settings, User } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import AppBranding from "../ui/AppBranding";
import { ROLE_PRIMARY_CACHE_KEY } from "@/lib/theme/themeConstants";
import { fetchJson } from "@/lib/api";

type NotificationItem = {
  id: string;
  type: string;
  title: string;
  body: string | null;
  created_at: string;
  read_at: string | null;
  org_id: string | null;
  entity: string | null;
  entity_id: string | null;
  href: string | null;
  metadata: Record<string, unknown>;
};

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, { year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function DashboardHeader() {
  const { user, dbUser } = useAuth();
  const router = useRouter();
  const [avatarError, setAvatarError] = useState(false);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const isLoggedIn = !!user && !!dbUser?.role;

  // If the user uploads a new avatar, reset previous image error state so the header can render it.
  useEffect(() => {
    setAvatarError(false);
  }, [dbUser?.avatar_url]);

  const orgKey = useMemo(() => {
    return dbUser?.organization_slug ?? dbUser?.organization_id ?? null;
  }, [dbUser?.organization_id, dbUser?.organization_slug]);

  const displayName = useMemo(() => {
    const name = (dbUser?.full_name ?? "").trim();
    if (name.length) return name;
    return dbUser?.email ?? user?.email ?? "My Account";
  }, [dbUser?.email, dbUser?.full_name, user?.email]);

  const roleLabel = useMemo(() => {
    const r = dbUser?.role ?? null;
    switch (r) {
      case "super_admin":
        return "Super Administrator/Developer";
      case "system_admin":
        return "System Administrator";
      case "organization_admin":
        return "Organization Administrator";
      case "member":
        return "Member";
      default:
        return null;
    }
  }, [dbUser?.role]);

  const [notifOpen, setNotifOpen] = useState(false);
  const [notifLoading, setNotifLoading] = useState(false);
  const [notifError, setNotifError] = useState<string | null>(null);
  const [unreadCount, setUnreadCount] = useState(0);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const notifRef = useRef<HTMLDivElement | null>(null);
  const profileMenuRef = useRef<HTMLDivElement | null>(null);

  const profileHref = useMemo(() => {
    const role = dbUser?.role ?? null;
    if (!role) return null;
    if (role === "super_admin") return "/admin/profile";
    if (role === "system_admin") return "/system/profile";
    if (role === "organization_admin" || role === "member") {
      if (orgKey) return `/org/${orgKey}/profile`;
      return null;
    }
    return null;
  }, [dbUser?.role, orgKey]);

  const coursesHref = useMemo(() => {
    const role = dbUser?.role ?? null;
    if (!role) return null;
    if (role === "super_admin") return "/admin/courses";
    if (role === "system_admin") return "/system/courses";
    if ((role === "organization_admin" || role === "member") && orgKey) {
      return role === "member" ? `/org/${orgKey}/my-courses` : `/org/${orgKey}/courses`;
    }
    return null;
  }, [dbUser?.role, orgKey]);

  const coursesLabel = useMemo(() => {
    const role = dbUser?.role ?? null;
    if (!role) return "Courses";
    return role === "member" ? "My Learning" : "Courses";
  }, [dbUser?.role]);

  const computeNotificationHref = useMemo(() => {
    const role = dbUser?.role ?? null;
    return (n: NotificationItem): string | null => {
      if (n.href) return n.href;

      if (n.type === "organization_created") {
        if (role === "super_admin") return "/admin/organizations";
        if (role === "system_admin") return "/system/organizations";
        return null;
      }

      if (n.type === "course_published") {
        const id = n.entity_id;
        if (!id) return null;
        if (role === "super_admin") return `/admin/courses/${id}`;
        if (role === "system_admin") return `/system/courses/${id}`;
        if ((role === "organization_admin" || role === "member") && orgKey) return `/org/${orgKey}/courses/${id}`;
        return null;
      }

      if (n.type === "member_activated") {
        // Recipients are org admins; keep them in org context.
        if (role === "organization_admin" && orgKey) return `/org/${orgKey}/users`;
        return null;
      }

      if (n.type === "org_admin_activated") {
        if (role === "super_admin") return "/admin/users";
        if (role === "system_admin") return "/system/users";
        return null;
      }

      return null;
    };
  }, [dbUser?.role, orgKey]);

  const loadNotifications = useCallback(async () => {
    if (!user) return;
    setNotifLoading(true);
    setNotifError(null);
    try {
      const { data } = await fetchJson<{ unreadCount: number; notifications: NotificationItem[] }>("/api/notifications", {
        cache: "no-store",
      });
      setUnreadCount(typeof data.unreadCount === "number" ? data.unreadCount : 0);
      setNotifications(Array.isArray(data.notifications) ? data.notifications : []);
    } catch (e) {
      setNotifError(e instanceof Error ? e.message : "Failed to load notifications");
    } finally {
      setNotifLoading(false);
    }
  }, [user]);

  async function markRead(input: { all?: boolean; notificationId?: string }) {
    if (!user) return;
    const payload = input.all ? { all: true } : { notification_id: input.notificationId };

    await fetchJson<{ ok: true }>("/api/notifications/read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  // Initial load + light polling (keeps badge fresh without realtime).
  useEffect(() => {
    if (!user) return;
    void loadNotifications();
    const id = window.setInterval(() => void loadNotifications(), 30_000);
    return () => window.clearInterval(id);
  }, [loadNotifications, user]);

  // Refresh when opening dropdown (read-your-writes feel).
  useEffect(() => {
    if (!notifOpen) return;
    void loadNotifications();
  }, [loadNotifications, notifOpen]);

  // Close notifications on outside click / escape
  useEffect(() => {
    if (!notifOpen) return;

    const onMouseDown = (e: MouseEvent) => {
      const el = notifRef.current;
      if (!el) return;
      if (e.target instanceof Node && el.contains(e.target)) return;
      setNotifOpen(false);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setNotifOpen(false);
    };

    document.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [notifOpen]);

  // Close profile menu on outside click / escape
  useEffect(() => {
    if (!profileMenuOpen) return;

    const onMouseDown = (e: MouseEvent) => {
      const el = profileMenuRef.current;
      if (!el) return;
      if (e.target instanceof Node && el.contains(e.target)) return;
      setProfileMenuOpen(false);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setProfileMenuOpen(false);
    };

    document.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [profileMenuOpen]);

  const handleLogout = useCallback(async () => {
    if (isLoggingOut) return;
    setIsLoggingOut(true);
    try {
      try {
        localStorage.removeItem(ROLE_PRIMARY_CACHE_KEY);
      } catch {
        // ignore
      }
      await fetch("/api/auth/logout", { method: "POST" });
      // Hard redirect so proxy.ts re-evaluates cookies immediately
      window.location.assign("/");
    } catch (err) {
      // Best-effort; keep the menu open if it fails so user can retry.
      console.error("Logout error:", err);
      setIsLoggingOut(false);
    }
  }, [isLoggingOut]);

  return (
    <header className="sticky top-0 z-99999 border-b bg-background">
      <div className="flex h-full items-center justify-between px-6 py-1">
        <div className="flex items-center gap-3">
          <div className="origin-left">
            <AppBranding />
          </div>
        </div>

        <div className="flex items-center gap-4">
          {/* Language Switcher */}
          <button 
            className="flex items-center gap-2 text-sm text-foreground hover:text-secondary transition-colors hover:cursor-pointer"
            aria-label="Change language"
          >
            <Globe size={20} />
            {/* TODO: Implement language switching */}
          </button>

          {/* Notifications (only if logged in) */}
          {isLoggedIn ? (
            <div ref={notifRef} className="relative">
              <button
                type="button"
                className="relative flex items-center gap-2 text-sm text-foreground hover:text-secondary transition-colors hover:cursor-pointer"
                aria-label="Notifications"
                aria-haspopup="menu"
                aria-expanded={notifOpen}
                onClick={() => setNotifOpen((v) => !v)}
              >
                <Bell size={20} />
                {unreadCount > 0 ? (
                  <span className="absolute -top-1 -right-2 min-w-[18px] h-[18px] px-1 rounded-full bg-red-600 text-white text-[11px] leading-[18px] text-center">
                    {unreadCount > 9 ? "9+" : unreadCount}
                  </span>
                ) : null}
              </button>

              {notifOpen ? (
                <div
                  role="menu"
                  className="absolute right-0 mt-3 w-[360px] rounded-lg border bg-background shadow-lg overflow-hidden z-50"
                >
                  <div className="px-4 py-3 border-b flex items-center justify-between">
                    <div className="font-medium text-foreground">Notifications</div>
                    <button
                      type="button"
                      className="text-xs text-muted-foreground hover:text-foreground"
                      onClick={async () => {
                        try {
                          await markRead({ all: true });
                          // optimistic UI
                          setNotifications((prev) => prev.map((n) => ({ ...n, read_at: n.read_at ?? new Date().toISOString() })));
                          setUnreadCount(0);
                        } catch (e) {
                          setNotifError(e instanceof Error ? e.message : "Failed to mark all as read");
                        }
                      }}
                      disabled={unreadCount === 0 || notifLoading}
                    >
                      Mark all read
                    </button>
                  </div>

                  {notifError ? (
                    <div className="px-4 py-3 text-sm text-destructive border-b bg-destructive/5">
                      {notifError}
                    </div>
                  ) : null}

                  <div className="max-h-[420px] overflow-auto">
                    {notifLoading ? (
                      <div className="px-4 py-6 text-sm text-muted-foreground">Loading…</div>
                    ) : notifications.length === 0 ? (
                      <div className="px-4 py-6 text-sm text-muted-foreground">No notifications yet.</div>
                    ) : (
                      notifications.map((n) => {
                        const isUnread = !n.read_at;
                        const href = computeNotificationHref(n);
                        return (
                          <button
                            key={n.id}
                            type="button"
                            role="menuitem"
                            className={`w-full text-left px-4 py-3 border-b last:border-b-0 hover:bg-muted/40 transition-colors ${
                              isUnread ? "bg-muted/20" : ""
                            }`}
                            onClick={async () => {
                              try {
                                if (isUnread) {
                                  await markRead({ notificationId: n.id });
                                  setNotifications((prev) =>
                                    prev.map((x) => (x.id === n.id ? { ...x, read_at: new Date().toISOString() } : x))
                                  );
                                  setUnreadCount((c) => Math.max(0, c - 1));
                                }
                              } catch {
                                // non-fatal; still allow navigation
                              } finally {
                                if (href) router.push(href);
                                setNotifOpen(false);
                              }
                            }}
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className="flex items-center gap-2">
                                  {isUnread ? <span className="h-2 w-2 rounded-full bg-primary" /> : <span className="h-2 w-2 rounded-full bg-transparent" />}
                                  <div className="font-medium text-sm text-foreground truncate">{n.title}</div>
                                </div>
                                {n.body ? (
                                  <div className="mt-1 text-sm text-muted-foreground line-clamp-2">{n.body}</div>
                                ) : null}
                                <div className="mt-1 text-xs text-muted-foreground">{formatTime(n.created_at)}</div>
                              </div>
                            </div>
                          </button>
                        );
                      })
                    )}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}

          {/* User Profile (only if logged in) */}
          {isLoggedIn && (
            <div ref={profileMenuRef} className="relative">
              <button 
                type="button"
                className="flex items-center gap-2 text-sm text-foreground hover:text-secondary transition-colors hover:cursor-pointer"
                aria-label="Open profile menu"
                aria-haspopup="menu"
                aria-expanded={profileMenuOpen}
                onClick={() => setProfileMenuOpen((v) => !v)}
              >
                {dbUser?.avatar_url && !avatarError ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={dbUser.avatar_url}
                    alt="Avatar"
                    className="h-8 w-8 rounded-full object-cover border"
                    onError={() => setAvatarError(true)}
                  />
                ) : (
                  <User size={20} />
                )}
              </button>

              {profileMenuOpen ? (
                <div
                  role="menu"
                  className="absolute right-0 mt-3 w-[320px] rounded-lg border bg-background shadow-lg overflow-hidden z-50"
                >
                  <div className="px-4 py-3 border-b bg-muted/30">
                    <div className="flex items-center gap-3">
                      {dbUser?.avatar_url && !avatarError ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={dbUser.avatar_url}
                          alt="Avatar"
                          className="h-10 w-10 rounded-full object-cover border bg-background"
                          onError={() => setAvatarError(true)}
                        />
                      ) : (
                        <div className="h-10 w-10 rounded-full border flex items-center justify-center bg-background text-muted-foreground">
                          <User size={18} />
                        </div>
                      )}
                      <div className="min-w-0">
                        <div className="font-medium text-foreground truncate">{displayName}</div>
                        {roleLabel ? (
                          <div className="text-xs text-muted-foreground truncate">{roleLabel}</div>
                        ) : null}
                      </div>
                    </div>
                  </div>

                  <div className="py-1">
                    {profileHref ? (
                      <Link
                        href={profileHref}
                        role="menuitem"
                        className="flex items-center gap-3 px-4 py-2.5 text-sm text-foreground hover:bg-muted/40 transition-colors"
                        onClick={() => setProfileMenuOpen(false)}
                      >
                        <User size={18} className="text-muted-foreground" />
                        <span>Profile</span>
                      </Link>
                    ) : null}

                    <Link
                      href="#"
                      role="menuitem"
                      className="flex items-center gap-3 px-4 py-2.5 text-sm text-foreground hover:bg-muted/40 transition-colors"
                      onClick={(e) => {
                        e.preventDefault();
                        setProfileMenuOpen(false);
                      }}
                    >
                      <Settings size={18} className="text-muted-foreground" />
                      <span>Settings</span>
                    </Link>

                    <Link
                      href="#"
                      role="menuitem"
                      className="flex items-center gap-3 px-4 py-2.5 text-sm text-foreground hover:bg-muted/40 transition-colors"
                      onClick={(e) => {
                        e.preventDefault();
                        setProfileMenuOpen(false);
                      }}
                    >
                      <Palette size={18} className="text-muted-foreground" />
                      <span>Theme</span>
                    </Link>

                    {coursesHref ? (
                      <Link
                        href={coursesHref}
                        role="menuitem"
                        className="flex items-center gap-3 px-4 py-2.5 text-sm text-foreground hover:bg-muted/40 transition-colors"
                        onClick={() => setProfileMenuOpen(false)}
                      >
                        <BookOpen size={18} className="text-muted-foreground" />
                        <span>{coursesLabel}</span>
                      </Link>
                    ) : null}

                    <div className="my-1 border-t" />

                    <button
                      type="button"
                      role="menuitem"
                      className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-foreground hover:bg-muted/40 transition-colors disabled:opacity-60 hover:cursor-pointer"
                      onClick={async () => {
                        setProfileMenuOpen(false);
                        await handleLogout();
                      }}
                      disabled={isLoggingOut}
                    >
                      <LogOut size={18} className="text-muted-foreground" />
                      <span>{isLoggingOut ? "Logging out..." : "Logout"}</span>
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </header>
  );
}