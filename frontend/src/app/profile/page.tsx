"use client";

// Own profile — resolves the player name from localStorage.

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, UserRound } from "lucide-react";
import { useProfileName } from "@/components/ProfileNameDialog";
import { SceneBackground } from "@/components/SceneBackground";
import { ProfileView } from "@/components/profile/ProfileView";

export default function OwnProfilePage() {
  const { name, loaded } = useProfileName();

  if (!loaded) {
    return (
      <main className="mx-auto w-full max-w-lg flex-1 space-y-3 px-4 py-6">
        <SceneBackground src="/hub-bg.png" blur overlay="strong" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </main>
    );
  }

  if (!name) {
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
        </header>
        <Card className="border-dashed">
          <CardContent className="py-10 text-center text-muted-foreground">
            <UserRound className="mx-auto mb-2 size-8 opacity-40" />
            <p className="text-sm">You haven’t chosen a player name yet.</p>
            <p className="mt-1 text-xs">
              Set your name from the home screen to unlock your profile.
            </p>
            <Button asChild variant="link" className="mt-1 text-violet-400">
              <Link href="/">Back to home</Link>
            </Button>
          </CardContent>
        </Card>
      </main>
    );
  }

  return <ProfileView name={name} own />;
}
