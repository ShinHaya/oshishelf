"use server";

import { getViewer } from "@/lib/session";
import { requireAdminPermission, grantAdminPermission, revokeAdminPermission, getAuditLogs, type AdminPermission } from "@/lib/admin";
import { redirect } from "next/navigation";
import { attempt, type ActionResult } from "@/lib/action-result";

export type { ActionResult } from "@/lib/action-result";

export async function grantAdminAction(targetUid: string, permissions: AdminPermission[], reason: string): Promise<ActionResult> {
  const viewer = await getViewer();
  if (!viewer) redirect("/login");

  return attempt(async () => {
    await grantAdminPermission(targetUid, permissions, reason);
  });
}

export async function revokeAdminAction(targetUid: string, permissions: AdminPermission[], reason: string): Promise<ActionResult> {
  const viewer = await getViewer();
  if (!viewer) redirect("/login");

  return attempt(async () => {
    await revokeAdminPermission(targetUid, permissions, reason);
  });
}

export async function getAuditLogsAction(): Promise<ActionResult<void>> {
  const viewer = await getViewer();
  if (!viewer) redirect("/login");

  return attempt(async () => {
    await requireAdminPermission("view");
    await getAuditLogs();
  });
}
