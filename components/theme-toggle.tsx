"use client";

import { useTheme } from "@/lib/theme";

interface ThemeToggleProps {
  collapsed?: boolean;
}

function SunIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 16 16"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path d="M8 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm0-5a1 1 0 1 1 0 2 1 1 0 0 1 0-2Z" />
      <path
        fillRule="evenodd"
        d="M8 0a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0V.75A.75.75 0 0 1 8 0Zm0 13a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0v-1.5A.75.75 0 0 1 8 13ZM2.34 2.34a.75.75 0 0 1 1.06 0l1.06 1.06A.75.75 0 1 1 3.4 4.46L2.34 3.4a.75.75 0 0 1 0-1.06Zm9.2 9.2a.75.75 0 0 1 1.06 0l1.06 1.06a.75.75 0 1 1-1.06 1.06l-1.06-1.06a.75.75 0 0 1 0-1.06ZM0 8a.75.75 0 0 1 .75-.75h1.5a.75.75 0 0 1 0 1.5H.75A.75.75 0 0 1 0 8Zm13 0a.75.75 0 0 1 .75-.75h1.5a.75.75 0 0 1 0 1.5h-1.5A.75.75 0 0 1 13 8ZM2.34 13.66a.75.75 0 0 1 0-1.06l1.06-1.06a.75.75 0 1 1 1.06 1.06l-1.06 1.06a.75.75 0 0 1-1.06 0Zm9.2-9.2a.75.75 0 0 1 0-1.06l1.06-1.06a.75.75 0 1 1 1.06 1.06l-1.06 1.06a.75.75 0 0 1-1.06 0Z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function MoonIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 16 16"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path
        fillRule="evenodd"
        d="M7.23 1.05A.75.75 0 0 1 7.98 2.3a5.25 5.25 0 0 0 5.72 7.4.75.75 0 0 1 .82 1.02A6.75 6.75 0 1 1 7.23 1.05Zm-1.6 1.84a6.75 6.75 0 0 0-2.8 5.36c0 3.73 3.02 6.75 6.75 6.75a6.73 6.73 0 0 0 3.94-1.27A6.75 6.75 0 0 1 5.63 2.89Z"
        clipRule="evenodd"
      />
    </svg>
  );
}

export function ThemeToggle({ collapsed = false }: ThemeToggleProps) {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === "dark";

  const baseClass = collapsed
    ? "flex h-9 w-9 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
    : "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-zinc-600 transition-colors hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800";
  const iconClass = collapsed ? "h-4 w-4" : "h-4 w-4 shrink-0";

  return (
    <button
      onClick={toggleTheme}
      title={isDark ? "Switch to light mode" : "Switch to dark mode"}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      className={baseClass}
    >
      {isDark ? <SunIcon className={iconClass} /> : <MoonIcon className={iconClass} />}
      {!collapsed && (
        <span className="flex-1 text-left">
          {isDark ? "Light mode" : "Dark mode"}
        </span>
      )}
    </button>
  );
}
