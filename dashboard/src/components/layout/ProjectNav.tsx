'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { Files, Key, Webhook, BarChart3, Settings } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

const iconMap: Record<string, LucideIcon> = {
  Files,
  Key,
  Webhook,
  BarChart3,
  Settings,
};

interface Tab {
  href: string;
  label: string;
  icon?: string;
  exact?: boolean;
}

export default function ProjectNav({ tabs }: { tabs: Tab[] }) {
  const pathname = usePathname();

  function isActive(tab: Tab) {
    if (tab.exact) return pathname === tab.href;
    return pathname.startsWith(tab.href);
  }

  return (
    <nav className="flex gap-1 overflow-x-auto rounded-lg border bg-muted/50 p-1">
      {tabs.map((tab) => {
        const Icon = tab.icon ? iconMap[tab.icon] : undefined;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={cn(
              'flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors md:gap-2 md:px-3',
              isActive(tab)
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:bg-background/50 hover:text-foreground',
            )}
          >
            {Icon && <Icon className="h-4 w-4" />}
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
