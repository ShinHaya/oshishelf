import { describe, expect, it } from "vitest";
import { validateFirebaseConfig } from "./firebase-config";

const config = { apiKey: "fictional-key", authDomain: "fictional-staging.firebaseapp.com", projectId: "fictional-staging", appId: "fictional-app" };
describe("Firebase environment isolation", () => {
  it("accepts matching web and server projects", () => {
    expect(() => validateFirebaseConfig(config, config.projectId)).not.toThrow();
  });
  it("rejects a web client pointing to another project", () => {
    expect(() => validateFirebaseConfig(config, "fictional-production")).toThrow("same project");
  });
  it("rejects missing server configuration", () => {
    expect(() => validateFirebaseConfig(config, undefined)).toThrow("same project");
  });
  it.each(["apiKey", "authDomain", "projectId", "appId"])("rejects missing %s", (key) => {
    expect(() => validateFirebaseConfig({ ...config, [key]: "" }, config.projectId)).toThrow("NEXT_PUBLIC_FIREBASE");
  });
});
