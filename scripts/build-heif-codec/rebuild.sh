#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
task_tmp="${HEIF_BUILD_TMP:-$(mktemp -d /tmp/jt-studio-task2-heif.XXXXXX)}"
evidence_dir="$repo_root/.superpowers/sdd/2026-10-11-blog-editorial/task2-fix2-logs"
snapshot="${TASK2_PROTECTED_DOCKER_SNAPSHOT:-/tmp/jt-studio-protected-docker-20261011.json}"
image='emscripten/emsdk@sha256:52549e68ad6dd0f3509ff378bc1a5d317d40030c8991919cada0dad95d85e00c'
mkdir -p "$task_tmp/source" "$task_tmp/output" "$evidence_dir"
[[ -f "$snapshot" ]] || { echo "Missing protected Docker inventory: $snapshot" >&2; exit 2; }

docker ps -a --no-trunc --format '{{.ID}} {{.Names}} {{.Image}} {{.State}}' > "$evidence_dir/docker-containers-before.txt"
docker volume ls --format '{{.Name}}' | sort > "$evidence_dir/docker-volumes-before.txt"
docker image ls --no-trunc --format '{{.ID}} {{.Repository}}:{{.Tag}}' | sort > "$evidence_dir/docker-images-before.txt"
jq -r '.protectedContainers[].ID' "$snapshot" | sort > "$task_tmp/protected-container-ids.txt"
jq -r '.protectedVolumes[].Name' "$snapshot" | sort > "$task_tmp/protected-volume-names.txt"
awk '{print substr($1, 1, 12)}' "$evidence_dir/docker-containers-before.txt" | sort > "$task_tmp/current-container-ids.txt"
docker volume ls --format '{{.Name}}' | sort > "$task_tmp/current-volume-names.txt"
diff -u "$task_tmp/protected-container-ids.txt" "$task_tmp/current-container-ids.txt"
diff -u "$task_tmp/protected-volume-names.txt" "$task_tmp/current-volume-names.txt"
{
  printf 'Docker Desktop: '; docker version --format '{{.Server.Version}} ({{.Server.Os}}/{{.Server.Arch}})'
  printf 'protected snapshot: %s\n' "$snapshot"
  printf 'containers before: '; wc -l < "$evidence_dir/docker-containers-before.txt"
  printf 'volumes before: '; wc -l < "$evidence_dir/docker-volumes-before.txt"
  printf 'images before: '; wc -l < "$evidence_dir/docker-images-before.txt"
  printf 'task temp: %s\n' "$task_tmp"
  printf 'image: %s\n' "$image"
} | tee "$evidence_dir/docker-build-runtime.txt"

curl --fail --location --retry 2 \
  https://github.com/strukturag/libheif/archive/refs/tags/v1.23.6.tar.gz \
  --output "$task_tmp/libheif-v1.23.6.tar.gz"
curl --fail --location --retry 2 \
  https://github.com/strukturag/libde265/archive/refs/tags/v1.1.3.tar.gz \
  --output "$task_tmp/libde265-v1.1.3.tar.gz"
printf '%s  %s\n' \
  c9a00b0452f5c16d72ef71e5e40c0e90fbe2ad37148d27a1b2f9bb21546f5f03 "$task_tmp/libheif-v1.23.6.tar.gz" \
  189baa08fd6d2dd34db099de411bd6b2e6bd5eb88e81236a3d0fa3826b9715c4 "$task_tmp/libde265-v1.1.3.tar.gz" \
  | sha256sum --check | tee "$evidence_dir/source-archive-checksums.txt"
tar -xzf "$task_tmp/libheif-v1.23.6.tar.gz" -C "$task_tmp/source"
tar -xzf "$task_tmp/libde265-v1.1.3.tar.gz" -C "$task_tmp/source"

docker pull --platform linux/amd64 "$image" 2>&1 | tee "$evidence_dir/docker-pull.txt"
docker image inspect "$image" --format '{{.Id}} {{.Os}}/{{.Architecture}} {{json .RepoDigests}}' | tee "$evidence_dir/docker-image-identity.txt"
uid="$(id -u)"
gid="$(id -g)"
name="jt-studio-task2-heif-codec-$(date -u +%Y%m%dT%H%M%SZ)-$$"
container_id="$(docker create \
  --name "$name" \
  --label task=jt-studio-task2-heif-codec \
  --label purpose=approved-local-reproducible-codec-build \
  --platform linux/amd64 \
  --user "$uid:$gid" \
  --network none \
  --cpus 2 \
  --memory 3g \
  --memory-swap 3g \
  --pids-limit 512 \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --workdir /tmp \
  --env HOME=/tmp/jt-studio-heif-build/home \
  --env EM_CACHE=/tmp/jt-studio-heif-build/emscripten-cache \
  --entrypoint /bin/bash \
  "$image" /tmp/build-offline.sh)"
printf 'container name=%s\ncontainer id=%s\nuser=%s:%s\n' "$name" "$container_id" "$uid" "$gid" | tee "$evidence_dir/docker-build-container.txt"
docker inspect "$container_id" | jq '.[0] | {Id,Name,Config:{User:.Config.User,Labels:.Config.Labels},HostConfig:{NetworkMode:.HostConfig.NetworkMode,ReadonlyRootfs:.HostConfig.ReadonlyRootfs,CapDrop:.HostConfig.CapDrop,SecurityOpt:.HostConfig.SecurityOpt,PortBindings:.HostConfig.PortBindings},Mounts}' > "$evidence_dir/docker-build-container-inspect.json"
jq -e '(.Mounts|length)==0 and .HostConfig.NetworkMode=="none" and .Config.User=="'"$uid:$gid"'" and ((.HostConfig.PortBindings // {})|length)==0' "$evidence_dir/docker-build-container-inspect.json" >/dev/null
docker cp "$task_tmp/libheif-v1.23.6.tar.gz" "$container_id:/tmp/libheif-v1.23.6.tar.gz"
docker cp "$task_tmp/libde265-v1.1.3.tar.gz" "$container_id:/tmp/libde265-v1.1.3.tar.gz"
docker cp "$repo_root/scripts/build-heif-codec/build-offline.sh" "$container_id:/tmp/build-offline.sh"
docker cp "$repo_root/scripts/build-heif-codec/heif_adapter.cpp" "$container_id:/tmp/heif_adapter.cpp"
printf 'copied verified archives and build scripts to ephemeral container writable layer; no mounts\n' | tee "$evidence_dir/docker-build-inputs.txt"
if ! docker start -a "$container_id" 2>&1 | tee "$evidence_dir/codec-build.log"; then
  docker inspect "$container_id" --format '{{json .State}}' > "$evidence_dir/docker-build-failed-state.json" || true
  echo "Codec build failed; preserved only task-owned container $container_id for diagnosis." >&2
  exit 1
fi
docker inspect "$container_id" --format '{{json .State}}' > "$evidence_dir/docker-build-success-state.json"

mkdir -p "$repo_root/src/blog/codecs"
docker cp "$container_id:/tmp/jt-studio-heif-build/output/heif-decoder.js" "$task_tmp/output/heif-decoder.js"
docker cp "$container_id:/tmp/jt-studio-heif-build/output/heif-decoder.wasm" "$task_tmp/output/heif-decoder.wasm"
docker cp "$container_id:/tmp/jt-studio-heif-build/compiler-version.txt" "$task_tmp/compiler-version.txt"
docker cp "$container_id:/tmp/jt-studio-heif-build/output-sha256.txt" "$task_tmp/output-sha256.txt"
cp "$task_tmp/output/heif-decoder.js" "$repo_root/src/blog/codecs/heif-decoder.js"
cp "$task_tmp/output/heif-decoder.wasm" "$repo_root/src/blog/codecs/heif-decoder.wasm"
cp "$task_tmp/compiler-version.txt" "$evidence_dir/compiler-version.txt"
cp "$task_tmp/output-sha256.txt" "$evidence_dir/output-sha256.txt"
node "$repo_root/scripts/build-heif-codec/write-manifest.mjs" \
  "$repo_root/src/blog/codecs" "$task_tmp/compiler-version.txt" \
  "$repo_root/src/blog/codecs/heif-codec.manifest.json"
node -e "const fs=require('node:fs'); console.log(fs.readFileSync(process.argv[1],'utf8'))" \
  "$repo_root/src/blog/codecs/heif-codec.manifest.json" | tee "$evidence_dir/heif-codec.manifest.json"
docker rm "$container_id" | tee "$evidence_dir/docker-build-container-removed.txt"
sha256sum "$repo_root/src/blog/codecs/heif-decoder.js" "$repo_root/src/blog/codecs/heif-decoder.wasm" \
  "$repo_root/src/blog/codecs/heif-codec.manifest.json" | tee "$evidence_dir/final-artifact-sha256.txt"
