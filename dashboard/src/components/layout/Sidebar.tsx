'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useSession, signOut } from 'next-auth/react';
import { cn } from '@/lib/utils';
import {
  LayoutDashboard,
  FolderKanban,
  Settings,
  HardDrive,
  X,
  ChevronRight,
  LogOut,
  BookOpen,
  ArrowUpCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';

const navItems = [
  { href: '/dashboard', label: 'Overview', icon: LayoutDashboard },
  { href: '/dashboard/projects', label: 'Projects', icon: FolderKanban },
  { href: '/dashboard/docs', label: 'Docs', icon: BookOpen },
  { href: '/dashboard/account', label: 'Account', icon: Settings },
];

function useUpdateCheck() {
  const [update, setUpdate] = useState<{
    has_update: boolean;
    latest_version: string;
    current_version: string;
    release_url: string;
    update_command: string;
  } | null>(null);

  useEffect(() => {
    fetch('/api/system/update-check')
      .then((r) => r.json())
      .then((data) => {
        if (data.has_update) setUpdate(data);
      })
      .catch(() => {});
  }, []);

  return update;
}

function NavContent({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const { data: session } = useSession();
  const update = useUpdateCheck();

  const initials = session?.user?.name
    ?.split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2) || 'U';

  return (
    <div className="flex flex-1 flex-col">
      {/* Update banner */}
      {update && (
        <div className="mx-3 mt-3 rounded-lg border border-emerald-500/30 bg-gradient-to-br from-emerald-500/10 to-green-500/5 px-3 py-2.5">
          <div className="flex items-center gap-2">
            <ArrowUpCircle className="h-4 w-4 text-emerald-400" />
            <p className="text-[11px] font-semibold text-emerald-400">Update available</p>
          </div>
          <p className="mt-1 text-[10px] text-muted-foreground">
            v{update.current_version} → v{update.latest_version}
          </p>
          <code className="mt-1.5 block rounded bg-muted/50 px-2 py-1 text-[9px] text-muted-foreground">
            {update.update_command}
          </code>
          {update.release_url && (
            <a
              href={update.release_url}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1.5 inline-block text-[10px] font-medium text-emerald-400/80 transition-colors hover:text-emerald-400"
            >
              Release notes &rarr;
            </a>
          )}
        </div>
      )}

      {/* Navigation */}
      <nav className="flex-1 space-y-0.5 px-3 py-4">
        <p className="mb-2 px-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/60">
          Menu
        </p>
        {navItems.map((item) => {
          const active =
            item.href === '/dashboard'
              ? pathname === '/dashboard'
              : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={onNavigate}
              className={cn(
                'group flex items-center gap-3 rounded-lg px-2.5 py-2 text-[13px] font-medium transition-all',
                active
                  ? 'bg-primary text-primary-foreground shadow-sm'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              <item.icon className={cn('h-4 w-4 shrink-0', active ? 'text-primary-foreground' : 'text-muted-foreground/70 group-hover:text-foreground')} />
              <span className="flex-1">{item.label}</span>
              {active && <ChevronRight className="h-3.5 w-3.5 opacity-50" />}
            </Link>
          );
        })}
      </nav>

      {/* SendMailOS promo */}
      <div className="px-3 pb-2">
        <a
          href="https://sendmailos.com"
          target="_blank"
          rel="noopener noreferrer"
          className="group block rounded-lg border border-border/50 bg-gradient-to-br from-orange-500/10 to-amber-500/5 px-3 py-2.5 transition-all hover:border-orange-500/30 hover:shadow-sm"
        >
          <p className="text-[11px] font-semibold text-orange-400">SendMailOS</p>
          <p className="mt-0.5 text-[10px] leading-snug text-muted-foreground">
            Email platform. 2,000+ free emails/month.
          </p>
          <span className="mt-1 inline-block text-[10px] font-medium text-orange-400/80 transition-colors group-hover:text-orange-400">
            Try free &rarr;
          </span>
        </a>
      </div>

      {/* Bottom user section */}
      <div className="border-t px-3 py-3">
        <div className="flex items-center gap-2.5 rounded-lg px-2.5 py-2">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[11px] font-bold text-primary">
            {initials}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-medium leading-none">{session?.user?.name || 'User'}</p>
            <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{session?.user?.email}</p>
          </div>
          <button
            onClick={() => signOut({ callbackUrl: '/login' })}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground"
            title="Sign out"
          >
            <LogOut className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

export default function Sidebar({
  open,
  onClose,
}: {
  open?: boolean;
  onClose?: () => void;
}) {
  return (
    <>
      {/* Desktop sidebar */}
      <aside className="hidden h-screen w-[220px] shrink-0 flex-col border-r border-border/50 bg-card/50 backdrop-blur-sm md:flex">
        <div className="flex h-14 items-center gap-2.5 border-b border-border/50 px-5">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary shadow-sm">
            <HardDrive className="h-3.5 w-3.5 text-primary-foreground" />
          </div>
          <span className="text-[15px] font-semibold tracking-tight">MediaOS</span>
        </div>
        <NavContent />
      </aside>

      {/* Mobile sidebar overlay */}
      {open && (
        <>
          <div
            className="fixed inset-0 z-40 bg-background/80 backdrop-blur-sm md:hidden"
            onClick={onClose}
          />
          <aside className="fixed inset-y-0 left-0 z-50 flex w-[260px] flex-col border-r border-border/50 bg-card shadow-xl md:hidden">
            <div className="flex h-14 items-center justify-between border-b border-border/50 px-5">
              <div className="flex items-center gap-2.5">
                <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary shadow-sm">
                  <HardDrive className="h-3.5 w-3.5 text-primary-foreground" />
                </div>
                <span className="text-[15px] font-semibold tracking-tight">MediaOS</span>
              </div>
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose}>
                <X className="h-4 w-4" />
              </Button>
            </div>
            <NavContent onNavigate={onClose} />
          </aside>
        </>
      )}
    </>
  );
}
