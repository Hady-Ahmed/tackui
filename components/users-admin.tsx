"use client";

import { useState, useEffect, useCallback } from "react";
import { authClient } from "@/lib/auth/auth-client";

interface UserRow {
  id: string;
  name: string;
  email: string;
  role: string;
  banned: boolean;
  createdAt: Date | null;
}

export function UsersAdmin() {
  const { data: session } = authClient.useSession();
  const [users, setUsers] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadUsers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/config");
      const config = await res.json();
      if (config.authDisabled) {
        setLoading(false);
        return;
      }
    } catch {
      // ignore
    }

    const result = await authClient.admin.listUsers({
      query: { limit: 100 },
    });

    if (result.error) {
      setError(result.error.message ?? "Failed to load users");
      setLoading(false);
      return;
    }

    const rows: UserRow[] = (result.data?.users ?? []).map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role ?? "user",
      banned: u.banned ?? false,
      createdAt: u.createdAt ? new Date(u.createdAt) : null,
    }));
    setUsers(rows);
    setLoading(false);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (cancelled) return;
      await loadUsers();
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [loadUsers]);

  if (!session || session.user.role !== "admin") {
    return null;
  }

  const handleSetRole = async (userId: string, role: "user" | "admin") => {
    const result = await authClient.admin.setRole({ userId, role });
    if (result.error) {
      setError(result.error.message ?? "Failed to set role");
      return;
    }
    await loadUsers();
  };

  const handleToggleBan = async (userId: string, currentlyBanned: boolean) => {
    if (currentlyBanned) {
      const result = await authClient.admin.unbanUser({ userId });
      if (result.error) {
        setError(result.error.message ?? "Failed to unban user");
        return;
      }
    } else {
      const result = await authClient.admin.banUser({ userId });
      if (result.error) {
        setError(result.error.message ?? "Failed to ban user");
        return;
      }
    }
    await loadUsers();
  };

  if (loading) {
    return (
      <section className="mb-10">
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-zinc-400">
          Users
        </h2>
        <p className="text-sm text-zinc-400">Loading...</p>
      </section>
    );
  }

  return (
    <section className="mb-10">
      <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-zinc-400">
        Users ({users.length})
      </h2>
      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          {error}
        </div>
      )}
      {users.length === 0 ? (
        <p className="text-sm text-zinc-400">No users found.</p>
      ) : (
        <>
          {/* Desktop table — hidden on mobile. */}
          <div className="hidden overflow-hidden rounded-xl border border-zinc-200 md:block dark:border-zinc-800">
            <table className="w-full text-left text-sm">
              <thead className="bg-zinc-100 text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
                <tr>
                  <th className="px-4 py-2">Name</th>
                  <th className="px-4 py-2">Email</th>
                  <th className="px-4 py-2">Role</th>
                  <th className="px-4 py-2">Status</th>
                  <th className="px-4 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
                {users.map((user) => (
                  <tr key={user.id} className="bg-white dark:bg-zinc-950">
                    <td className="px-4 py-3 font-medium text-zinc-900 dark:text-zinc-50">
                      {user.name}
                      {user.id === session.user.id && (
                        <span className="ml-1 text-xs text-zinc-400">(you)</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400">
                      {user.email}
                    </td>
                    <td className="px-4 py-3">
                      <select
                        value={user.role}
                        onChange={(e) => handleSetRole(user.id, e.target.value as "user" | "admin")}
                        disabled={user.id === session.user.id}
                        className="rounded border border-zinc-200 px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50 disabled:opacity-50"
                      >
                        <option value="user">user</option>
                        <option value="admin">admin</option>
                      </select>
                    </td>
                    <td className="px-4 py-3">
                      {user.banned ? (
                        <span className="rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-medium uppercase text-red-600 dark:bg-red-950 dark:text-red-400">
                          Banned
                        </span>
                      ) : (
                        <span className="rounded bg-green-100 px-1.5 py-0.5 text-[10px] font-medium uppercase text-green-600 dark:bg-green-950 dark:text-green-400">
                          Active
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => handleToggleBan(user.id, user.banned)}
                        disabled={user.id === session.user.id}
                        className="text-xs font-medium text-zinc-600 hover:underline disabled:opacity-50 dark:text-zinc-400"
                      >
                        {user.banned ? "Unban" : "Ban"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile card list — stacked per user. Hidden on desktop. */}
          <ul className="space-y-3 md:hidden">
            {users.map((user) => (
              <li
                key={user.id}
                className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium text-zinc-900 dark:text-zinc-50">
                      {user.name}
                      {user.id === session.user.id && (
                        <span className="ml-1 text-xs text-zinc-400">(you)</span>
                      )}
                    </p>
                    <p className="mt-0.5 truncate text-sm text-zinc-600 dark:text-zinc-400">
                      {user.email}
                    </p>
                  </div>
                  {user.banned ? (
                    <span className="shrink-0 rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-medium uppercase text-red-600 dark:bg-red-950 dark:text-red-400">
                      Banned
                    </span>
                  ) : (
                    <span className="shrink-0 rounded bg-green-100 px-1.5 py-0.5 text-[10px] font-medium uppercase text-green-600 dark:bg-green-950 dark:text-green-400">
                      Active
                    </span>
                  )}
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <select
                    value={user.role}
                    onChange={(e) => handleSetRole(user.id, e.target.value as "user" | "admin")}
                    disabled={user.id === session.user.id}
                    className="rounded border border-zinc-200 px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50 disabled:opacity-50"
                  >
                    <option value="user">user</option>
                    <option value="admin">admin</option>
                  </select>
                  <button
                    onClick={() => handleToggleBan(user.id, user.banned)}
                    disabled={user.id === session.user.id}
                    className="text-xs font-medium text-zinc-600 hover:underline disabled:opacity-50 dark:text-zinc-400"
                  >
                    {user.banned ? "Unban" : "Ban"}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
