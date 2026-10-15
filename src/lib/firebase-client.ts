"use client";

import { getApps, initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";

// Firebase web config is public by design; access is enforced server-side.
const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

const app = getApps()[0] ?? initializeApp(firebaseConfig);
export const clientAuth = getAuth(app);
