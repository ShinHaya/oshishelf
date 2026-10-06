"use client";

import { useState, useTransition } from "react";
import { toggleFollowAction } from "@/app/actions";

export function FollowButton({ targetUid, initial }: { targetUid: string; initial: boolean }) {
  const [following, setFollowing] = useState(initial);
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const r = await toggleFollowAction(targetUid);
          if (r.ok) setFollowing(r.data);
        })
      }
      className={following ? "btn-ghost" : "btn-primary"}
    >
      {following ? "フォロー中" : "フォローする"}
    </button>
  );
}
