#!/usr/bin/env bash
set -euo pipefail

ROOT=/tmp/jt-studio-heif-build
SRC="$ROOT/source"
BUILD="$ROOT/build"
PREFIX="$ROOT/stage"
OUT="$ROOT/output"
mkdir -p "$SRC" "$BUILD" "$PREFIX" "$OUT"
tar -xzf /tmp/libheif-v1.23.6.tar.gz -C "$SRC"
tar -xzf /tmp/libde265-v1.1.3.tar.gz -C "$SRC"

emcmake cmake -S "$SRC/libde265-1.1.3" -B "$BUILD/libde265" \
  -DCMAKE_BUILD_TYPE=MinSizeRel \
  -DCMAKE_INSTALL_PREFIX="$PREFIX" \
  -DBUILD_SHARED_LIBS=OFF \
  -DENABLE_SDL=OFF -DENABLE_SIMD=OFF -DENABLE_AVX2=OFF -DENABLE_AVX512=OFF \
  -DENABLE_DECODER=ON -DENABLE_ENCODER=OFF -DENABLE_SHERLOCK265=OFF \
  -DENABLE_INTERNAL_DEVELOPMENT_TOOLS=OFF -DWITH_FUZZERS=OFF
cmake --build "$BUILD/libde265" --parallel 2
cmake --install "$BUILD/libde265"

emcmake cmake -S "$SRC/libheif-1.23.6" -B "$BUILD/libheif" \
  -DCMAKE_BUILD_TYPE=MinSizeRel \
  -DCMAKE_INSTALL_PREFIX="$PREFIX" \
  -DBUILD_SHARED_LIBS=OFF -DENABLE_PLUGIN_LOADING=OFF \
  '-DCMAKE_CXX_FLAGS=-D__EMSCRIPTEN_STANDALONE_WASM__=1 -fwasm-exceptions' \
  -DLIBDE265_INCLUDE_DIR="$PREFIX/include" \
  -DLIBDE265_LIBRARY="$PREFIX/lib/libde265.a" \
  -DWITH_LIBDE265=ON -DWITH_LIBDE265_PLUGIN=OFF \
  -DWITH_X265=OFF -DWITH_X265_PLUGIN=OFF \
  -DWITH_KVAZAAR=OFF -DWITH_KVAZAAR_PLUGIN=OFF \
  -DWITH_AOM_DECODER=OFF -DWITH_AOM_DECODER_PLUGIN=OFF \
  -DWITH_AOM_ENCODER=OFF -DWITH_AOM_ENCODER_PLUGIN=OFF \
  -DWITH_DAV1D=OFF -DWITH_DAV1D_PLUGIN=OFF \
  -DWITH_SvtEnc=OFF -DWITH_SvtEnc_PLUGIN=OFF \
  -DWITH_RAV1E=OFF -DWITH_RAV1E_PLUGIN=OFF \
  -DWITH_JPEG_DECODER=OFF -DWITH_JPEG_DECODER_PLUGIN=OFF \
  -DWITH_JPEG_ENCODER=OFF -DWITH_JPEG_ENCODER_PLUGIN=OFF \
  -DWITH_OpenJPEG_DECODER=OFF -DWITH_OpenJPEG_DECODER_PLUGIN=OFF \
  -DWITH_OpenJPEG_ENCODER=OFF -DWITH_OpenJPEG_ENCODER_PLUGIN=OFF \
  -DWITH_FFMPEG_DECODER=OFF -DWITH_FFMPEG_DECODER_PLUGIN=OFF \
  -DWITH_X264=OFF -DWITH_X264_PLUGIN=OFF \
  -DWITH_OpenH264_DECODER=OFF -DWITH_OpenH264_DECODER_PLUGIN=OFF \
  -DWITH_OPENJPH_ENCODER=OFF -DWITH_OPENJPH_ENCODER_PLUGIN=OFF \
  -DWITH_UNCOMPRESSED_CODEC=OFF -DWITH_WEBCODECS=OFF \
  -DWITH_EXAMPLES=OFF -DWITH_GDK_PIXBUF=OFF -DBUILD_TESTING=OFF \
  -DBUILD_DEVELOPMENT_TOOLS=OFF -DBUILD_DOCUMENTATION=OFF \
  -DWITH_HEADER_COMPRESSION=OFF \
  -DENABLE_MULTITHREADING_SUPPORT=OFF -DENABLE_PARALLEL_TILE_DECODING=OFF \
  -DWITH_REDUCED_VISIBILITY=OFF
cmake --build "$BUILD/libheif" --parallel 2
cmake --install "$BUILD/libheif"

em++ /tmp/heif_adapter.cpp "$BUILD/libheif/libheif/libheif.a" "$PREFIX/lib/libde265.a" \
  -O3 -std=c++20 -fwasm-exceptions -fno-rtti \
  -sWASM=1 -sMODULARIZE=1 -sEXPORT_ES6=1 \
  -sEXPORT_NAME=createHeifDecoder -sENVIRONMENT=worker \
  -sFILESYSTEM=0 -sDYNAMIC_EXECUTION=0 -sALLOW_MEMORY_GROWTH=1 \
  -sINITIAL_MEMORY=67108864 -sSTACK_SIZE=5242880 \
  -sEXPORTED_FUNCTIONS='["_malloc","_free","_task2_decode_primary_heif","_task2_libheif_version_major","_task2_libheif_version_minor","_task2_libheif_version_maintenance","_task2_libde265_version_major","_task2_libde265_version_minor","_task2_libde265_version_maintenance","_task2_heif_context_image_pixel_limit","_task2_heif_decode_thread_count"]' \
  -sEXPORTED_RUNTIME_METHODS='["HEAPU8","HEAPU32"]' \
  -I"$PREFIX/include" \
  -I"$SRC/libheif-1.23.6/libheif/api" \
  -I"$BUILD/libheif/libheif/api" \
  -o "$OUT/heif-decoder.js"

test -s "$OUT/heif-decoder.js"
test -s "$OUT/heif-decoder.wasm"
emcc --version > "$ROOT/compiler-version.txt"
sha256sum "$OUT/heif-decoder.js" "$OUT/heif-decoder.wasm" > "$ROOT/output-sha256.txt"
