#!/usr/bin/env bash
# Creates Firestore indexes (composite + vector) and locks down client access.
set -euo pipefail
PROJECT="${PROJECT:-oshishelf-hackathon}"
G="gcloud --project=$PROJECT --quiet"

idx() { $G firestore indexes composite create "$@" --async 2>&1 | grep -v "already exists" || true; }

idx --collection-group=items --field-config=field-path=ownerUid,order=ascending --field-config=field-path=status,order=ascending --field-config=field-path=publishedAt,order=descending
idx --collection-group=items --field-config=field-path=ownerUid,order=ascending --field-config=field-path=status,order=ascending --field-config=field-path=createdAt,order=descending
idx --collection-group=items --field-config=field-path=status,order=ascending --field-config=field-path=visibility,order=ascending --field-config=field-path=publishedAt,order=descending
idx --collection-group=items --field-config=field-path=ownerUid,order=ascending --field-config=field-path=productKey,order=ascending
idx --collection-group=agentRuns --field-config=field-path=uid,order=ascending --field-config=field-path=agent,order=ascending --field-config=field-path=startedAt,order=descending
# Collection-group single-field indexes: removing other users' wishes when an item or account is deleted.
for f in itemId ownerUid; do
  $G firestore indexes fields update "$f" --collection-group=wishes \
    --index=order=ascending,query-scope=collection --index=order=ascending,query-scope=collection-group --async 2>&1 || true
done
# Vector index for taste matching (gemini-embedding-001, 768 dims)
idx --collection-group=users --query-scope=COLLECTION --field-config='field-path=tasteVector,vector-config={"dimension":"768","flat":"{}"}'

# All data access goes through the server (Admin SDK); deny direct client access.
TOKEN=$(gcloud auth print-access-token)
RULES='rules_version = \"2\";\nservice cloud.firestore {\n  match /databases/{database}/documents {\n    match /{document=**} {\n      allow read, write: if false;\n    }\n  }\n}\n'
RULESET=$(curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "x-goog-user-project: $PROJECT" -H "Content-Type: application/json" \
  "https://firebaserules.googleapis.com/v1/projects/$PROJECT/rulesets" \
  -d "{\"source\":{\"files\":[{\"name\":\"firestore.rules\",\"content\":\"$RULES\"}]}}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["name"])')
curl -s -X PATCH -H "Authorization: Bearer $TOKEN" -H "x-goog-user-project: $PROJECT" -H "Content-Type: application/json" \
  "https://firebaserules.googleapis.com/v1/projects/$PROJECT/releases/cloud.firestore" \
  -d "{\"release\":{\"name\":\"projects/$PROJECT/releases/cloud.firestore\",\"rulesetName\":\"$RULESET\"}}" >/dev/null \
|| curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "x-goog-user-project: $PROJECT" -H "Content-Type: application/json" \
  "https://firebaserules.googleapis.com/v1/projects/$PROJECT/releases" \
  -d "{\"name\":\"projects/$PROJECT/releases/cloud.firestore\",\"rulesetName\":\"$RULESET\"}"
echo "Firestore setup requested (indexes build asynchronously)."
