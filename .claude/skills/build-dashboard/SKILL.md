---
name: build-dashboard
description: Build MediaVault Track 5 — Next.js Dashboard. Admin panel with auth, project management, file browser, API keys, webhooks, usage charts, and account settings.
disable-model-invocation: true
context: fork
---

# Track 5: Dashboard (Next.js 15)

Read `info.md` section 13 for complete specifications. Track 2 API must be working.

## Tasks

### TASK 5.1 — Scaffold + Auth
- Initialize Next.js 15 app in `dashboard/` with TypeScript, Tailwind, App Router
- Install and configure shadcn/ui
- Create `src/lib/api.ts` — Fetch wrapper for worker API (uses INTERNAL_API_URL + MASTER_KEY)
- Create `src/lib/auth.ts` — NextAuth credentials provider, validate against accounts table (bcrypt)
- Create `src/lib/utils.ts` — Format bytes, dates, relative time helpers
- Create `src/lib/types.ts` — Shared TypeScript interfaces matching API responses
- Create `src/app/api/auth/[...nextauth]/route.ts`
- Create `src/app/login/page.tsx` — Email + password form, redirect to /dashboard

### TASK 5.2 — Layout + Navigation
- Create `src/app/dashboard/layout.tsx` — Sidebar + auth check (redirect if not logged in)
- Create `src/components/layout/Sidebar.tsx` — Nav links: Overview, Projects, Account
- Create `src/components/layout/Header.tsx` — Page title, breadcrumbs
- Create `src/components/layout/ProjectSwitcher.tsx` — Dropdown to switch active project

### TASK 5.3 — Project Management
- Create `src/app/dashboard/page.tsx` — Overview: storage, bandwidth, recent uploads, project count
- Create `src/app/dashboard/projects/page.tsx` — Grid of ProjectCards
- Create `src/app/dashboard/projects/[id]/page.tsx` — Project detail with sub-nav
- Create `src/components/projects/ProjectCard.tsx`, `CreateProjectModal.tsx`, `ProjectSettings.tsx`
- Create `src/app/dashboard/projects/[id]/settings/page.tsx` — Edit name, processing settings, danger zone

### TASK 5.4 — File Browser
- Create `src/app/dashboard/projects/[id]/files/page.tsx`
- Create `src/components/files/FileGrid.tsx` — Thumbnail grid view
- Create `src/components/files/FileList.tsx` — Table list view
- Create `src/components/files/FilePreview.tsx` — Slide-over panel with preview + metadata + URLs
- Create `src/components/files/UploadDropzone.tsx` — Drag-and-drop upload
- Create `src/components/files/FileActions.tsx` — Copy URL, delete, download
- Grid/list toggle, search bar, folder filter, type filter, pagination

### TASK 5.5 — API Key Management
- Create `src/app/dashboard/projects/[id]/keys/page.tsx`
- Create `src/components/keys/KeyList.tsx` — Table with name, prefix (masked), scopes badges, status
- Create `src/components/keys/CreateKeyModal.tsx` — Name + scope checkboxes, show full key ONCE with copy button

### TASK 5.6 — Webhook Management
- Create `src/app/dashboard/projects/[id]/webhooks/page.tsx`
- Create `src/components/webhooks/WebhookList.tsx` — URL, event badges, delivery stats
- Create `src/components/webhooks/WebhookForm.tsx` — URL + event checkboxes, show secret ONCE

### TASK 5.7 — Usage Dashboard
- Create `src/app/dashboard/projects/[id]/usage/page.tsx`
- Create `src/components/usage/UsageChart.tsx` — Line chart (recharts): uploads per day
- Create `src/components/usage/BandwidthChart.tsx` — Line chart: bandwidth per day
- Create `src/components/usage/StorageBar.tsx` — Storage breakdown + plan limit bars

### TASK 5.8 — Account Settings
- Create `src/app/dashboard/account/page.tsx` — Name, email, change password, plan info

## Design Direction
- Dark-mode first (Vercel/Linear aesthetic)
- Tailwind CSS + shadcn/ui components
- Monospace for code/keys/URLs
- Responsive but desktop-primary
- Server components by default, "use client" only when needed

## Rules
- TypeScript strict mode
- No CSS modules, no styled-components — Tailwind only
- All API calls through `src/lib/api.ts`
- shadcn/ui as component base
