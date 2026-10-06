import type { UserProfile } from "@/lib/types";

export function Avatar({ profile, size = 40 }: { profile: Pick<UserProfile, "displayName" | "avatarHue">; size?: number }) {
  return (
    <span
      className="grid shrink-0 place-items-center rounded-full font-display font-bold text-white"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.42,
        background: `linear-gradient(135deg, hsl(${profile.avatarHue} 70% 62%), hsl(${(profile.avatarHue + 40) % 360} 70% 50%))`,
      }}
      aria-hidden
    >
      {[...profile.displayName][0] ?? "?"}
    </span>
  );
}
