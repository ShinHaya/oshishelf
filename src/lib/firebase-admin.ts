import "server-only";
import { getApps, initializeApp, applicationDefault } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

export const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT ?? "oshishelf-hackathon";

if (process.env.FIREBASE_WEB_PROJECT_ID && process.env.FIREBASE_WEB_PROJECT_ID !== PROJECT_ID) {
  throw new Error("Firebase client build and server project do not match.");
}

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
