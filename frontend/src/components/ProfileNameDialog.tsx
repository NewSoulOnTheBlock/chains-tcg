"use client";

import { useState, useSyncExternalStore } from "react";
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
import {
  getProfileName,
  setProfileName,
  subscribeProfile,
} from "@/lib/profile";
import { registerProfile } from "@/lib/profileApi";
import { useHydrated } from "@/hooks/useHydrated";

const serverName = () => "";

/** Profile name persisted in localStorage, exposed as an external store. */
export function useProfileName() {
  const name = useSyncExternalStore(subscribeProfile, getProfileName, serverName);
  const loaded = useHydrated();
  return { name, loaded, save: setProfileName };
}

export function ProfileNameDialog({
  open,
  onOpenChange,
  onSaved,
  dismissible = true,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: (name: string) => void;
  dismissible?: boolean;
}) {
  const [draft, setDraft] = useState("");
  // Re-seed the draft from storage each time the dialog opens
  // (render-time state adjustment — no effect needed).
  const [prevOpen, setPrevOpen] = useState(false);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) setDraft(getProfileName());
  }

  const submit = () => {
    const n = draft.trim();
    if (!n) return;
    setProfileName(n);
    registerProfile(n); // fire-and-forget server upsert
    onSaved?.(n);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => (dismissible || o) && onOpenChange(o)}>
      <DialogContent showCloseButton={dismissible}>
        <DialogHeader>
          <DialogTitle>Choose your name</DialogTitle>
          <DialogDescription>
            Shown to your opponents in matches.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          className="flex flex-col gap-3"
        >
          <Input
            autoFocus
            value={draft}
            maxLength={24}
            placeholder="e.g. ChainBreaker"
            onChange={(e) => setDraft(e.target.value)}
          />
          <DialogFooter>
            <Button type="submit" disabled={!draft.trim()}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
