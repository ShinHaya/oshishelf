import "server-only";
import { getApps, initializeApp, applicationDefault } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

export const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT ?? "oshishelf-hackathon";

const app =
  getApps()[0] ??
  initializeApp({
    credential: applicationDefault(),
    projectId: PROJECT_ID,
  });

export const adminAuth = getAuth(app);
export const db = getFirestore(app);

try {
  db.settings({ ignoreUndefinedProperties: true });
} catch {
  // settings() throws if called twice during hot reload
}
