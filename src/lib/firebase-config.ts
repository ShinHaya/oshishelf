export interface FirebaseWebConfig {
  apiKey?: string;
  authDomain?: string;
  projectId?: string;
  appId?: string;
}

/** Reject partial configuration and cross-project builds before deployment. */
export function validateFirebaseConfig(config: FirebaseWebConfig, serverProject: string | undefined): void {
  if (!config.apiKey || !config.authDomain || !config.projectId || !config.appId) {
    throw new Error("Set all NEXT_PUBLIC_FIREBASE_* values from the target Firebase project before building.");
  }
  if (!serverProject || config.projectId !== serverProject) {
    throw new Error("Firebase Web and GOOGLE_CLOUD_PROJECT must use the same project.");
  }
}
