"use client";

// Public read-only profile for any player, addressed by name.

import { useParams } from "next/navigation";
import { ProfileView } from "@/components/profile/ProfileView";

export default function PublicProfilePage() {
  const params = useParams<{ name: string }>();
  const raw = params?.name ?? "";
  let name = raw;
  try {
    name = decodeURIComponent(raw);
  } catch {
    /* keep raw on malformed escapes */
  }
  return <ProfileView name={name} own={false} />;
}
