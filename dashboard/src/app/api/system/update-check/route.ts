import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';

const API_URL = process.env.INTERNAL_API_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';
const GITHUB_REPO = 'arrrrniii/MediaOs';

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // Get current version from worker
    const healthRes = await fetch(`${API_URL}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    const health = await healthRes.json();
    const currentVersion = health.version || '0.0.0';

    // Check latest GitHub release
    let latestVersion = currentVersion;
    let releaseUrl = '';
    let releaseNotes = '';
    let publishedAt = '';

    try {
      const ghRes = await fetch(
        `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
        {
          headers: { Accept: 'application/vnd.github.v3+json' },
          signal: AbortSignal.timeout(5000),
          next: { revalidate: 3600 }, // Cache for 1 hour
        },
      );

      if (ghRes.ok) {
        const release = await ghRes.json();
        latestVersion = release.tag_name?.replace(/^v/, '') || currentVersion;
        releaseUrl = release.html_url || '';
        releaseNotes = release.body || '';
        publishedAt = release.published_at || '';
      }
    } catch {
      // GitHub API unavailable — just report current version
    }

    const hasUpdate = compareVersions(latestVersion, currentVersion) > 0;

    return NextResponse.json({
      current_version: currentVersion,
      latest_version: latestVersion,
      has_update: hasUpdate,
      release_url: releaseUrl,
      release_notes: releaseNotes,
      published_at: publishedAt,
      update_command: 'docker compose pull && docker compose up -d',
    });
  } catch {
    return NextResponse.json({ error: 'Failed to check for updates' }, { status: 500 });
  }
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}
