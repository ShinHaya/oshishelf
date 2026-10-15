import "server-only";
import { getViewer } from "./session";
import { db } from "./firebase-admin";

export type AdminPermission = "view" | "operate";

export interface AdminUser {
  uid: string;
  email: string;
  permissions: AdminPermission[];
  grantedAt: number;
  grantedBy: string;
}

export interface AuditLog {
  id: string;
  executor: string;
  action: string;
  target: string;
  timestamp: number;
  reason: string;
  success: boolean;
  errorMessage?: string;
}

const ADMIN_COLLECTION = "admins";
const AUDIT_COLLECTION = "auditLogs";

export async function getAdminUsers(): Promise<Map<string, AdminUser>> {
  const snapshot = await db.collection(ADMIN_COLLECTION).get();
  const admins = new Map<string, AdminUser>();
  snapshot.docs.forEach((doc) => {
    admins.set(doc.id, doc.data() as AdminUser);
  });
  return admins;
}

export async function isAdmin(uid: string): Promise<boolean> {
  const admins = await getAdminUsers();
  return admins.has(uid);
}

export async function hasPermission(uid: string, permission: AdminPermission): Promise<boolean> {
  const admins = await getAdminUsers();
  const admin = admins.get(uid);
  return admin ? admin.permissions.includes(permission) : false;
}

export async function requireAdminPermission(permission: AdminPermission = "view"): Promise<string> {
  const viewer = await getViewer();
  if (!viewer) {
    throw new Error("Unauthorized: Not logged in");
  }
  if (!viewer.profile) {
    throw new Error("Unauthorized: Profile not set up");
  }

  const hasPermissionResult = await hasPermission(viewer.uid, permission);
  if (!hasPermissionResult) {
    throw new Error("Unauthorized: Admin permission required");
  }

  return viewer.uid;
}

export async function grantAdminPermission(targetUid: string, permissions: AdminPermission[], reason: string): Promise<void> {
  const executorUid = await requireAdminPermission("operate");

  const adminRef = db.collection(ADMIN_COLLECTION).doc(targetUid);
  const existing = await adminRef.get();
  const now = Date.now();

  const adminUser: AdminUser = {
    uid: targetUid,
    email: existing.get("email") ?? "",
    permissions: Array.from(new Set([...(existing.get("permissions") ?? []), ...permissions])),
    grantedAt: now,
    grantedBy: executorUid,
  };

  await adminRef.set(adminUser);
  await logAudit(executorUid, "grant_admin_permission", targetUid, reason, true);
}

export async function revokeAdminPermission(targetUid: string, permissions: AdminPermission[], reason: string): Promise<void> {
  const executorUid = await requireAdminPermission("operate");

  const adminRef = db.collection(ADMIN_COLLECTION).doc(targetUid);
  const existing = await adminRef.get();

  if (!existing.exists) {
    await logAudit(executorUid, "revoke_admin_permission", targetUid, reason, false, "Admin not found");
    throw new Error("Admin not found");
  }

  const currentPermissions = (existing.get("permissions") ?? []) as AdminPermission[];
  const remainingPermissions = currentPermissions.filter((p: AdminPermission) => !permissions.includes(p));

  if (remainingPermissions.length === 0) {
    await adminRef.delete();
  } else {
    const adminUser = existing.data() as AdminUser;
    adminUser.permissions = remainingPermissions;
    await adminRef.set(adminUser);
  }

  await logAudit(executorUid, "revoke_admin_permission", targetUid, reason, true);
}

export async function logAudit(
  executor: string,
  action: string,
  target: string,
  reason: string,
  success: boolean,
  errorMessage?: string,
): Promise<void> {
  const auditLog: AuditLog = {
    id: db.collection(AUDIT_COLLECTION).doc().id,
    executor,
    action,
    target,
    timestamp: Date.now(),
    reason,
    success,
    errorMessage,
  };

  await db.collection(AUDIT_COLLECTION).doc(auditLog.id).set(auditLog);
}

export async function getAuditLogs(limit: number = 100): Promise<AuditLog[]> {
  const snapshot = await db.collection(AUDIT_COLLECTION).orderBy("timestamp", "desc").limit(limit).get();
  return snapshot.docs.map((doc) => doc.data() as AuditLog);
}
