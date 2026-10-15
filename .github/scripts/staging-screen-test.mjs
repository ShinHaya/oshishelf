#!/usr/bin/env node

import { execFile } from "child_process";
import { promisify } from "util";
import { writeFileSync } from "fs";

const execFileAsync = promisify(execFile);

const APP_ORIGIN = process.env.APP_ORIGIN;
const PROJECT_ID = process.env.PROJECT_ID;
const AI_TEST_SA_EMAIL = process.env.AI_TEST_SA_EMAIL;
const TARGET_SHA = process.env.TARGET_SHA;
const DEPLOYED_IMAGE = process.env.DEPLOYED_IMAGE;
const BUILD_DIGEST = process.env.BUILD_DIGEST;
const GITHUB_RUN_ID = process.env.GITHUB_RUN_ID;

if (!APP_ORIGIN || !PROJECT_ID || !AI_TEST_SA_EMAIL || !TARGET_SHA) {
  console.error("Missing required environment variables");
  process.exit(1);
}

const testResults = {
  sha: TARGET_SHA,
  runId: GITHUB_RUN_ID,
  timestamp: new Date().toISOString(),
  tests: [],
  url: APP_ORIGIN,
};

async function createIDToken() {
  console.log("Creating IDToken for AI test service account...");
  try {
    // For IAP, we need an IDToken, not access token. Use gcloud to create it.
    const { stdout: idtoken } = await execFileAsync("gcloud", [
      "auth", "application-default", "print-identity-token",
      `--impersonate-service-account=${AI_TEST_SA_EMAIL}`,
      `--audiences=${APP_ORIGIN}`,
    ], { timeout: 30000 });

    return idtoken.trim();
  } catch (error) {
    console.error("Failed to create IDToken:", error.message);
    throw error;
  }
}

async function testPageLoad(idToken) {
  console.log(`Testing page load from ${APP_ORIGIN}...`);
  try {
    const response = await fetch(`${APP_ORIGIN}/`, {
      headers: {
        Authorization: `Bearer ${idToken}`,
      },
    });

    const testResult = {
      name: "Page load test",
      url: `${APP_ORIGIN}/`,
      status: response.status,
      ok: response.ok,
      timestamp: new Date().toISOString(),
    };

    testResults.tests.push(testResult);

    // Verify deployed image matches build digest
    if (DEPLOYED_IMAGE && BUILD_DIGEST) {
      const imageMatch = DEPLOYED_IMAGE === BUILD_DIGEST;
      testResults.imageVerification = {
        deployed: DEPLOYED_IMAGE,
        built: BUILD_DIGEST,
        matches: imageMatch,
      };
      if (!imageMatch) {
        console.warn(`⚠ Deployed image does not match built digest`);
      }
    }

    if (!response.ok) {
      console.error(`Page load failed with status ${response.status}`);
      return false;
    }

    // Check if response contains HTML (not error page)
    const contentType = response.headers.get("content-type");
    if (!contentType?.includes("text/html")) {
      console.error(`Expected HTML response, got ${contentType}`);
      return false;
    }

    console.log("✓ Page load test passed");
    return true;
  } catch (error) {
    console.error("Page load test error:", error.message);
    testResults.tests.push({
      name: "Page load test",
      url: `${APP_ORIGIN}/`,
      ok: false,
      error: error.message,
      timestamp: new Date().toISOString(),
    });
    return false;
  }
}

async function testAPISession(idToken) {
  console.log("Testing session API...");
  try {
    const response = await fetch(`${APP_ORIGIN}/api/session`, {
      headers: {
        Authorization: `Bearer ${idToken}`,
      },
    });

    const testResult = {
      name: "Session API test",
      url: `${APP_ORIGIN}/api/session`,
      status: response.status,
      ok: response.ok,
      timestamp: new Date().toISOString(),
    };

    testResults.tests.push(testResult);

    if (response.status === 401 || response.status === 403) {
      // Session API returns 401 when not authenticated through Firebase
      // This is expected behavior
      console.log("✓ Session API correctly requires Firebase authentication");
      return true;
    }

    if (!response.ok) {
      console.error(`Session API test failed with status ${response.status}`);
      return false;
    }

    console.log("✓ Session API test passed");
    return true;
  } catch (error) {
    console.error("Session API test error:", error.message);
    testResults.tests.push({
      name: "Session API test",
      url: `${APP_ORIGIN}/api/session`,
      ok: false,
      error: error.message,
      timestamp: new Date().toISOString(),
    });
    return false;
  }
}

async function main() {
  console.log("Starting screen validation tests for staging deployment");
  console.log(`Target SHA: ${TARGET_SHA}`);
  console.log(`Project ID: ${PROJECT_ID}`);
  console.log(`App Origin: ${APP_ORIGIN}`);
  if (DEPLOYED_IMAGE) {
    console.log(`Deployed Image: ${DEPLOYED_IMAGE}`);
  }
  if (BUILD_DIGEST) {
    console.log(`Build Digest: ${BUILD_DIGEST}`);
  }

  try {
    const idToken = await createIDToken();
    console.log("✓ IDToken created successfully");

    let allTestsPassed = true;

    allTestsPassed = (await testPageLoad(idToken)) && allTestsPassed;
    allTestsPassed = (await testAPISession(idToken)) && allTestsPassed;

    testResults.success = allTestsPassed;

    // Write results to file
    writeFileSync("/tmp/screen-test-results.json", JSON.stringify(testResults, null, 2));

    // Output results in a structured format
    console.log("\n=== Test Results ===");
    console.log(JSON.stringify(testResults, null, 2));

    if (!allTestsPassed) {
      console.error("\n✗ Some tests failed");
      process.exit(1);
    }

    console.log("\n✓ All screen validation tests passed");
  } catch (error) {
    console.error("Fatal error during screen testing:", error);
    testResults.success = false;
    testResults.error = error.message;
    writeFileSync("/tmp/screen-test-results.json", JSON.stringify(testResults, null, 2));
    console.log(JSON.stringify(testResults, null, 2));
    process.exit(1);
  }
}

main();
