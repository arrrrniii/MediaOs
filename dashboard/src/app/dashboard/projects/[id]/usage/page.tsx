'use client';

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatBytes } from '@/lib/utils';
import type { UsageData, UsageHistoryEntry } from '@/lib/types';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  Legend,
} from 'recharts';
import { HardDrive, Wifi, Upload, Download, Activity, Image } from 'lucide-react';

const CHART_COLORS = {
  blue: '#6366f1',
  green: '#22c55e',
  orange: '#f59e0b',
  purple: '#a855f7',
  pink: '#ec4899',
  cyan: '#06b6d4',
};

const PIE_COLORS = [CHART_COLORS.blue, CHART_COLORS.green, CHART_COLORS.orange, CHART_COLORS.purple];

export default function UsagePage() {
  const params = useParams();
  const projectId = params.id as string;
  const [usage, setUsage] = useState<UsageData | null>(null);
  const [history, setHistory] = useState<UsageHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchUsage() {
      try {
        const res = await fetch(`/api/projects/${projectId}/usage`);
        if (res.ok) {
          const data = await res.json();
          if (data.usage) setUsage(data.usage);
          if (data.history?.data) setHistory(data.history.data);
        }
      } catch {
        // handle error
      } finally {
        setLoading(false);
      }
    }
    fetchUsage();
  }, [projectId]);

  if (loading) {
    return <div className="py-8 text-center text-muted-foreground">Loading usage data...</div>;
  }

  const tooltipStyle = {
    backgroundColor: 'var(--color-card)',
    border: '1px solid var(--color-border)',
    borderRadius: '8px',
    color: 'var(--color-foreground)',
    fontSize: '13px',
    boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
  };

  return (
    <div className="space-y-6">
      {usage && (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Storage
              </CardTitle>
              <HardDrive className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {formatBytes(usage.storage.used)}
              </div>
              <div className="mt-2 h-2 rounded-full bg-muted">
                <div
                  className="h-2 rounded-full transition-all"
                  style={{
                    width: `${Math.max(Math.min(usage.storage.percent, 100), 2)}%`,
                    backgroundColor: CHART_COLORS.blue,
                  }}
                />
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {usage.storage.percent.toFixed(1)}% of {formatBytes(usage.storage.limit)}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Bandwidth
              </CardTitle>
              <Wifi className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {formatBytes(usage.bandwidth.used)}
              </div>
              <div className="mt-2 h-2 rounded-full bg-muted">
                <div
                  className="h-2 rounded-full transition-all"
                  style={{
                    width: `${Math.max(Math.min(usage.bandwidth.percent, 100), 2)}%`,
                    backgroundColor: CHART_COLORS.green,
                  }}
                />
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {usage.bandwidth.percent.toFixed(1)}% of {formatBytes(usage.bandwidth.limit)}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Uploads
              </CardTitle>
              <Upload className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {usage.uploads.toLocaleString()}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {usage.transforms} transforms
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Downloads
              </CardTitle>
              <Download className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {usage.downloads.toLocaleString()}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {usage.files.total} total files
              </p>
            </CardContent>
          </Card>
        </div>
      )}

      {history.length > 0 && (
        <>
          <Card>
            <CardHeader className="flex flex-row items-center gap-2">
              <Activity className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-sm font-medium">
                Uploads per Day
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={history}>
                    <defs>
                      <linearGradient id="uploadGradient" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor={CHART_COLORS.blue} stopOpacity={0.3} />
                        <stop offset="95%" stopColor={CHART_COLORS.blue} stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                    <XAxis
                      dataKey="date"
                      tick={{ fontSize: 12, fill: 'var(--color-muted-foreground)' }}
                      tickFormatter={(v) => v.slice(5)}
                      stroke="var(--color-border)"
                    />
                    <YAxis
                      tick={{ fontSize: 12, fill: 'var(--color-muted-foreground)' }}
                      stroke="var(--color-border)"
                    />
                    <Tooltip contentStyle={tooltipStyle} />
                    <Area
                      type="monotone"
                      dataKey="uploads"
                      stroke={CHART_COLORS.blue}
                      strokeWidth={2}
                      fill="url(#uploadGradient)"
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center gap-2">
              <Wifi className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-sm font-medium">
                Bandwidth per Day
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={history}>
                    <defs>
                      <linearGradient id="barGradient" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor={CHART_COLORS.green} stopOpacity={0.9} />
                        <stop offset="95%" stopColor={CHART_COLORS.green} stopOpacity={0.4} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                    <XAxis
                      dataKey="date"
                      tick={{ fontSize: 12, fill: 'var(--color-muted-foreground)' }}
                      tickFormatter={(v) => v.slice(5)}
                      stroke="var(--color-border)"
                    />
                    <YAxis
                      tick={{ fontSize: 12, fill: 'var(--color-muted-foreground)' }}
                      tickFormatter={(v) => formatBytes(v)}
                      stroke="var(--color-border)"
                    />
                    <Tooltip
                      formatter={(value) => formatBytes(Number(value))}
                      contentStyle={tooltipStyle}
                    />
                    <Bar
                      dataKey="download_bytes"
                      fill="url(#barGradient)"
                      radius={[6, 6, 0, 0]}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>
        </>
      )}

      {usage && usage.files.total > 0 && (
        <Card>
          <CardHeader className="flex flex-row items-center gap-2">
            <Image className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-sm font-medium">
              Storage Breakdown by Type
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={[
                      { name: 'Images', value: usage.files.images },
                      { name: 'Videos', value: usage.files.videos },
                      { name: 'Other', value: usage.files.other },
                    ].filter((d) => d.value > 0)}
                    cx="50%"
                    cy="50%"
                    innerRadius={70}
                    outerRadius={100}
                    paddingAngle={4}
                    dataKey="value"
                    label={({ name, value }) => `${name}: ${value}`}
                    labelLine={{ stroke: 'var(--color-muted-foreground)' }}
                  >
                    {[0, 1, 2].map((i) => (
                      <Cell key={i} fill={PIE_COLORS[i]} strokeWidth={0} />
                    ))}
                  </Pie>
                  <Tooltip contentStyle={tooltipStyle} />
                  <Legend
                    wrapperStyle={{ fontSize: '13px' }}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <p className="mt-2 text-center text-sm text-muted-foreground">
              {usage.files.total.toLocaleString()} total files
            </p>
          </CardContent>
        </Card>
      )}

      {!usage && history.length === 0 && (
        <div className="py-8 text-center text-muted-foreground">
          No usage data available yet. Upload some files to see statistics.
        </div>
      )}
    </div>
  );
}
