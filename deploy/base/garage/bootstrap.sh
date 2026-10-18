#!/bin/sh
# Idempotent: assigns the single-node layout, imports the app's S3 key, creates the bucket.
set -eu
apk add --no-cache curl jq >/dev/null

api() {
  method=$1 path=$2
  shift 2
  curl -sfS -X "$method" -H "Authorization: Bearer $GARAGE_ADMIN_TOKEN" \
    -H 'Content-Type: application/json' "http://garage:3903$path" "$@"
}

until status=$(api GET /v2/GetClusterStatus 2>/dev/null); do
  echo 'waiting for garage...'
  sleep 2
done

if [ "$(echo "$status" | jq .layoutVersion)" = 0 ]; then
  node=$(echo "$status" | jq -r '.nodes[0].id')
  api POST /v2/UpdateClusterLayout -d "$(jq -n --arg id "$node" --argjson cap "$GARAGE_CAPACITY_BYTES" \
    '{roles: [{id: $id, zone: "dc1", capacity: $cap, tags: []}]}')" >/dev/null
  api POST /v2/ApplyClusterLayout -d '{"version": 1}' >/dev/null
  echo "layout applied for node $node"
fi

if ! api GET "/v2/GetKeyInfo?id=$S3_ACCESS_KEY_ID" >/dev/null 2>&1; then
  api POST /v2/ImportKey -d "$(jq -n --arg id "$S3_ACCESS_KEY_ID" --arg secret "$S3_SECRET_ACCESS_KEY" \
    '{accessKeyId: $id, secretAccessKey: $secret, name: "cairn-app"}')" >/dev/null
  echo "imported key $S3_ACCESS_KEY_ID"
fi

if ! info=$(api GET "/v2/GetBucketInfo?globalAlias=$S3_BUCKET" 2>/dev/null); then
  info=$(api POST /v2/CreateBucket -d "$(jq -n --arg b "$S3_BUCKET" '{globalAlias: $b}')")
  echo "created bucket $S3_BUCKET"
fi
bucket=$(echo "$info" | jq -er .id)

api POST /v2/AllowBucketKey -d "$(jq -n --arg b "$bucket" --arg k "$S3_ACCESS_KEY_ID" \
  '{bucketId: $b, accessKeyId: $k, permissions: {read: true, write: true, owner: true}}')" >/dev/null
echo 'garage ready'
