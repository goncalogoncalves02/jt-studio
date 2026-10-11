#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <limits>

#include <libde265/de265.h>
#include <libheif/heif.h>

extern "C" {

static constexpr uint64_t kTask2MaxImagePixels = 60'000'000;

int task2_libheif_version_major() { return heif_get_version_number_major(); }
int task2_libheif_version_minor() { return heif_get_version_number_minor(); }
int task2_libheif_version_maintenance() { return heif_get_version_number_maintenance(); }
int task2_libde265_version_major() { return de265_get_version_number_major(); }
int task2_libde265_version_minor() { return de265_get_version_number_minor(); }
int task2_libde265_version_maintenance() { return de265_get_version_number_maintenance(); }
uint32_t task2_heif_context_image_pixel_limit() {
  heif_context* context = heif_context_alloc();
  if (context == nullptr) return 0;
  heif_security_limits* limits = heif_context_get_security_limits(context);
  if (limits != nullptr) limits->max_image_size_pixels = kTask2MaxImagePixels;
  const uint32_t value = limits != nullptr && limits->max_image_size_pixels == kTask2MaxImagePixels
      ? static_cast<uint32_t>(limits->max_image_size_pixels)
      : 0;
  heif_context_free(context);
  return value;
}
uint32_t task2_heif_decode_thread_count() { return 1; }

// Returns [width, height, byteLength, tightly-packed RGBA pixels], all uint32/bytes.
uint32_t* task2_decode_primary_heif(const uint8_t* input, size_t input_size) {
  if (input == nullptr || input_size == 0 || input_size > 30u * 1024u * 1024u) return nullptr;

  heif_context* context = heif_context_alloc();
  if (context == nullptr) return nullptr;
  heif_security_limits* limits = heif_context_get_security_limits(context);
  if (limits == nullptr) {
    heif_context_free(context);
    return nullptr;
  }
  limits->max_image_size_pixels = kTask2MaxImagePixels;
  heif_image_handle* handle = nullptr;
  heif_image* image = nullptr;
  heif_decoding_options* decode_options = nullptr;
  heif_error read_error{};
  heif_error primary_error{};
  heif_error decode_error{};
  uint32_t* frame = nullptr;

  read_error = heif_context_read_from_memory(context, input, input_size, nullptr);
  if (read_error.code != heif_error_Ok) goto cleanup;
  primary_error = heif_context_get_primary_image_handle(context, &handle);
  if (primary_error.code != heif_error_Ok || handle == nullptr) goto cleanup;
  decode_options = heif_decoding_options_alloc();
  if (decode_options == nullptr) goto cleanup;
  decode_options->num_codec_threads = 1;
  decode_error = heif_decode_image(handle, &image, heif_colorspace_RGB, heif_chroma_interleaved_RGBA, decode_options);
  if (decode_error.code != heif_error_Ok || image == nullptr) goto cleanup;

  {
    const int width = heif_image_get_width(image, heif_channel_interleaved);
    const int height = heif_image_get_height(image, heif_channel_interleaved);
    int source_stride = 0;
    const uint8_t* source = heif_image_get_plane_readonly(image, heif_channel_interleaved, &source_stride);
    if (width <= 0 || height <= 0 || source == nullptr || source_stride < width * 4) goto cleanup;
    const size_t row_bytes = static_cast<size_t>(width) * 4u;
    if (row_bytes > std::numeric_limits<uint32_t>::max() ||
        static_cast<size_t>(height) > (std::numeric_limits<uint32_t>::max() - 12u) / row_bytes) goto cleanup;
    const size_t pixel_bytes = row_bytes * static_cast<size_t>(height);
    frame = static_cast<uint32_t*>(std::malloc(12u + pixel_bytes));
    if (frame == nullptr) goto cleanup;
    frame[0] = static_cast<uint32_t>(width);
    frame[1] = static_cast<uint32_t>(height);
    frame[2] = static_cast<uint32_t>(pixel_bytes);
    auto* destination = reinterpret_cast<uint8_t*>(frame) + 12;
    for (int row = 0; row < height; ++row) {
      std::memcpy(destination + static_cast<size_t>(row) * row_bytes,
                  source + static_cast<size_t>(row) * static_cast<size_t>(source_stride), row_bytes);
    }
  }

cleanup:
  if (decode_options != nullptr) heif_decoding_options_free(decode_options);
  if (image != nullptr) heif_image_release(image);
  if (handle != nullptr) heif_image_handle_release(handle);
  heif_context_free(context);
  return frame;
}

}
