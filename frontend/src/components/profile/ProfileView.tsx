"use client";

// Shared profile screen — used by /profile (own, editable) and
// /profile/[name] (anyone, read-only).

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, Link2, Lock, Pencil, Swords, UserX } from "lucide-react";
import {
  fetchMatches,
  fetchProfile,
  upsertProfile,
  type MatchSummary,
  type Profile,
} from "@/lib/profileApi";
import { SceneBackground } from "@/components/SceneBackground";
import { EditProfileDialog } from "@/components/profile/EditProfileDialog";
import {
  computeAchievements,
  levelProgress,
  relativeDate,
} from "@/components/profile/progression";

// ── Avatar ───────────────────────────────────────────────────────────────────

function ProfileAvatar({
  src,
  name,
  className = "size-24",
}: {
  src: string | null;
  name: string;
  className?: string;
}) {
  const [broken, setBroken] = useState(false);
  const showImage = !!src && !broken;
  return (
    <div
      className={`relative shrink-0 rounded-full p-[3px] bg-gradient-to-br from-violet-500 via-fuchsia-500 to-amber-400 shadow-lg shadow-violet-500/30 ${className}`}
    >
      <div className="size-full overflow-hidden rounded-full bg-background">
        {showImage ? (
          // eslint-disable-next-line @next/next/no-img-element -- remote avatar URLs are user-supplied, not statically known
          <img
            key={src}
            src={src}
            alt={name}
            onError={() => setBroken(true)}
            className="size-full object-cover"
          />
        ) : (
          <div className="flex size-full items-center justify-center bg-gradient-to-br from-violet-950 to-slate-900">
            <span className="font-heading text-3xl font-bold text-violet-300 select-none">
              {name.charAt(0).toUpperCase() || "?"}
            </span>
          </div>
        )}
      </div>
      {!showImage && (
        <span className="absolute -bottom-0.5 -right-0.5 flex size-7 items-center justify-center rounded-full border border-violet-500/40 bg-slate-900">
          <Link2 className="size-3.5 text-violet-400" />
        </span>
      )}
    </div>
  );
}

// ── Sections ─────────────────────────────────────────────────────────────────

function StatTile({
  label,
  value,
  accent,
}: {
  label: string;
  value: string | number;
  accent: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-card/80 px-3 py-3 text-center">
      <div className={`text-xl font-black tabular-nums ${accent}`}>{value}</div>
      <div className="mt-0.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
        {label}
      </div>
    </div>
  );
}

function SectionHeading({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <h2 className="font-heading text-sm font-bold uppercase tracking-widest">
        {title}
      </h2>
      {hint && (
        <span className="text-[10px] uppercase tracking-widest text-muted-foreground">
          {hint}
        </span>
      )}
      <span className="ml-1 h-px flex-1 bg-gradient-to-r from-violet-500/40 to-transparent" />
    </div>
  );
}

function MatchRow({ m }: { m: MatchSummary }) {
  const win = m.result === "win";
  return (
    <li className="flex items-center gap-3 px-3 py-2.5">
      <span
        className={`w-9 shrink-0 rounded-md py-0.5 text-center text-[10px] font-black uppercase tracking-wider ${
          win
            ? "bg-emerald-500/15 text-emerald-400"
            : "bg-red-500/15 text-red-400"
        }`}
      >
        {win ? "Win" : "Loss"}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm">
        <span className="text-muted-foreground">vs </span>
        {m.opponent === "Unknown" ? (
          <span className="font-semibold text-muted-foreground">Unknown</span>
        ) : (
          <Link
            href={`/profile/${encodeURIComponent(m.opponent)}`}
            className="font-semibold hover:text-violet-300 hover:underline"
          >
            {m.opponent}
          </Link>
        )}
      </span>
      <span className="shrink-0 text-[10px] uppercase tracking-widest text-muted-foreground">
        {m.mode}
      </span>
      <span className="w-16 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
        {relativeDate(m.createdAt)}
      </span>
    </li>
  );
}

// ── Main view ────────────────────────────────────────────────────────────────

export function ProfileView({ name, own }: { name: string; own: boolean }) {
  // undefined = loading, null = not found
  const [profile, setProfile] = useState<Profile | null | undefined>(undefined);
  const [matches, setMatches] = useState<MatchSummary[]>([]);
  const [editing, setEditing] = useState(false);

  const load = useCallback(async () => {
    setProfile(undefined);
    try {
      let p = await fetchProfile(name);
      // Own profile may exist only in localStorage so far — register it.
      if (!p && own) p = await upsertProfile(name);
      setProfile(p);
      if (p) setMatches(await fetchMatches(p.name, 20).catch(() => []));
    } catch {
      toast.error("Could not load the profile");
      setProfile((prev) => prev ?? null);
    }
  }, [name, own]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load]);

  const wins = profile?.wins ?? 0;
  const losses = profile?.losses ?? 0;
  const games = wins + losses;
  const winPct = games ? Math.round((wins / games) * 100) : 0;
  const xp = useMemo(() => levelProgress(games), [games]);
  const achievements = useMemo(
    () => computeAchievements(wins, losses, matches),
    [wins, losses, matches],
  );
  const earnedCount = achievements.filter((a) => a.earned).length;

  return (
    <main className="mx-auto w-full max-w-lg flex-1 space-y-5 px-4 py-6">
      <SceneBackground src="/hub-bg.png" blur overlay="strong" />

      <header className="flex items-center gap-3">
        <Button asChild variant="ghost" size="icon" aria-label="Back">
          <Link href="/">
            <ArrowLeft className="size-5" />
          </Link>
        </Button>
        <h1 className="font-heading text-xl font-bold tracking-wide">
          Profile
        </h1>
        {own && profile && (
          <Button
            variant="ghost"
            size="icon"
            className="ml-auto"
            onClick={() => setEditing(true)}
            aria-label="Edit profile"
          >
            <Pencil className="size-4" />
          </Button>
        )}
      </header>

      {profile === undefined && (
        <div className="space-y-3">
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      )}

      {profile === null && (
        <Card className="border-dashed">
          <CardContent className="py-10 text-center text-muted-foreground">
            <UserX className="mx-auto mb-2 size-8 opacity-40" />
            <p className="text-sm">No player named “{name}” found.</p>
            <Button asChild variant="link" className="mt-1 text-violet-400">
              <Link href="/">Back to home</Link>
            </Button>
          </CardContent>
        </Card>
      )}

      {profile && (
        <>
          {/* Hero */}
          <Card className="overflow-hidden border-violet-500/20 bg-gradient-to-b from-violet-950/40 to-card">
            <CardContent className="flex flex-col items-center gap-4 py-6 text-center">
              <ProfileAvatar src={profile.avatarUrl} name={profile.name} />
              <div className="w-full space-y-1">
                <div className="flex items-center justify-center gap-2">
                  <span className="font-heading text-2xl font-bold tracking-wide">
                    {profile.name}
                  </span>
                  <span className="rounded-full border border-amber-400/40 bg-amber-400/10 px-2 py-0.5 text-[10px] font-black uppercase tracking-widest text-amber-300">
                    Lv {xp.level}
                  </span>
                </div>
                {profile.bio ? (
                  <p className="mx-auto max-w-sm text-sm leading-relaxed text-muted-foreground whitespace-pre-line">
                    {profile.bio}
                  </p>
                ) : (
                  own && (
                    <button
                      onClick={() => setEditing(true)}
                      className="text-xs text-muted-foreground/70 italic hover:text-violet-300"
                    >
                      Add a bio…
                    </button>
                  )
                )}
              </div>
              {/* XP bar */}
              <div className="w-full max-w-xs space-y-1">
                <div
                  className="h-2 overflow-hidden rounded-full border border-border bg-background/60"
                  role="progressbar"
                  aria-valuenow={xp.pct}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label="XP progress"
                >
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-violet-500 to-amber-400 transition-all duration-500"
                    style={{ width: `${xp.pct}%` }}
                  />
                </div>
                <div className="flex justify-between text-[10px] uppercase tracking-widest text-muted-foreground">
                  <span>
                    {xp.xpInto}/{xp.xpRange} XP
                  </span>
                  <span>Next: Lv {xp.level + 1}</span>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Stats */}
          <section className="space-y-2.5">
            <SectionHeading title="Stats" />
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <StatTile label="Wins" value={wins} accent="text-emerald-400" />
              <StatTile label="Losses" value={losses} accent="text-red-400" />
              <StatTile
                label="Win %"
                value={games ? `${winPct}%` : "—"}
                accent="text-violet-300"
              />
              <StatTile label="Games" value={games} accent="text-amber-300" />
            </div>
          </section>

          {/* Achievements */}
          <section className="space-y-2.5">
            <SectionHeading
              title="Achievements"
              hint={`${earnedCount}/${achievements.length}`}
            />
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {achievements.map((a) => {
                const Icon = a.earned ? a.icon : Lock;
                return (
                  <div
                    key={a.id}
                    title={`${a.title} — ${a.description}`}
                    className={`rounded-xl border px-2 py-3 text-center transition-colors ${
                      a.earned
                        ? "border-amber-400/40 bg-amber-400/10 shadow-[0_0_14px_-4px] shadow-amber-400/40"
                        : "border-border bg-card/60 opacity-50"
                    }`}
                  >
                    <Icon
                      className={`mx-auto mb-1.5 size-5 ${
                        a.earned ? "text-amber-300" : "text-muted-foreground"
                      }`}
                    />
                    <div
                      className={`text-[11px] font-bold leading-tight ${
                        a.earned ? "" : "text-muted-foreground"
                      }`}
                    >
                      {a.title}
                    </div>
                    <div className="mt-0.5 text-[9px] leading-tight text-muted-foreground">
                      {a.description}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          {/* Match history */}
          <section className="space-y-2.5">
            <SectionHeading title="Match History" hint="Last 20" />
            {matches.length === 0 ? (
              <Card className="border-dashed">
                <CardContent className="py-8 text-center text-muted-foreground">
                  <Swords className="mx-auto mb-2 size-8 opacity-40" />
                  <p className="text-sm">No matches recorded yet.</p>
                  <p className="mt-1 text-xs">
                    Multiplayer results appear here after each game.
                  </p>
                </CardContent>
              </Card>
            ) : (
              <ol className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
                {matches.map((m) => (
                  <MatchRow key={m.id} m={m} />
                ))}
              </ol>
            )}
          </section>

          {own && (
            <EditProfileDialog
              profile={profile}
              open={editing}
              onOpenChange={setEditing}
              onSaved={setProfile}
            />
          )}
        </>
      )}
    </main>
  );
}
