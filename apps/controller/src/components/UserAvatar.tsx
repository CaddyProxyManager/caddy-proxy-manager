"use client";

import { Avatar } from "@astryxdesign/core/Avatar";
import type { AvatarSize } from "@astryxdesign/core/Avatar";
import type { ResolvedAvatar } from "@/src/lib/avatar";

interface UserAvatarProps {
  /** From resolveAvatar() on the server. */
  avatar: ResolvedAvatar;
  /** Drives the initials, alt text and tooltip. */
  alt?: string;
  size?: AvatarSize;
  /** Off where the name is already visible beside it. */
  tooltip?: boolean;
}

/** Astryx's Avatar falls back from `src` to `fallbackSrc` (Gravatar) to initials. */
export function UserAvatar({ avatar, alt, size = "md", tooltip }: UserAvatarProps) {
  return (
    <Avatar
      src={avatar.imageUrl ?? undefined}
      fallbackSrc={avatar.gravatarUrl ?? undefined}
      name={alt?.trim() || avatar.initial}
      size={size}
      tooltip={tooltip}
    />
  );
}
