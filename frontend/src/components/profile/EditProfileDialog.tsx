"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { patchProfile, type Profile } from "@/lib/profileApi";

export function EditProfileDialog({
  profile,
  open,
  onOpenChange,
  onSaved,
}: {
  profile: Profile;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (updated: Profile) => void;
}) {
  const [avatarUrl, setAvatarUrl] = useState("");
  const [bio, setBio] = useState("");
  const [busy, setBusy] = useState(false);

  // Re-seed drafts from the profile each time the dialog opens
  // (render-time state adjustment — no effect needed).
  const [prevOpen, setPrevOpen] = useState(false);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setAvatarUrl(profile.avatarUrl ?? "");
      setBio(profile.bio ?? "");
    }
  }

  const submit = async () => {
    setBusy(true);
    try {
      const updated = await patchProfile(profile.name, {
        avatarUrl: avatarUrl.trim(),
        bio: bio.trim(),
      });
      onSaved(updated);
      onOpenChange(false);
      toast.success("Profile updated");
    } catch {
      toast.error("Could not save your profile");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit profile</DialogTitle>
          <DialogDescription>
            Your avatar and bio are visible to other players.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          className="flex flex-col gap-4"
        >
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            Avatar URL
            <Input
              type="url"
              value={avatarUrl}
              maxLength={1024}
              placeholder="https://example.com/avatar.png"
              onChange={(e) => setAvatarUrl(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            Bio
            <textarea
              value={bio}
              maxLength={500}
              rows={4}
              placeholder="Tell other players about yourself…"
              onChange={(e) => setBio(e.target.value)}
              className="w-full resize-none rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-base transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm dark:bg-input/30"
            />
            <span className="text-[10px] font-normal text-muted-foreground text-right">
              {bio.length}/500
            </span>
          </label>
          <DialogFooter>
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
