"use client";

import { getApps, initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";

// Firebase web config is public by design; access is enforced server-side.
const firebaseConfig = {
  apiKey: "AIzaSyCM52v_-XjONUX1fmLhRALI01SoZdO_F0I",
  authDomain: "oshishelf-hackathon.firebaseapp.com",
  projectId: "oshishelf-hackathon",
  appId: "1:948562731:web:ef79e975be8eefb18c336e",
};

const app = getApps()[0] ?? initializeApp(firebaseConfig);
export const clientAuth = getAuth(app);
