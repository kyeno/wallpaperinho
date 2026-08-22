## Real-ESRGAN-ncnn-vulkan

[https://github.com/xinntao/Real-ESRGAN-ncnn-vulkan](https://github.com/xinntao/Real-ESRGAN-ncnn-vulkan)

aka

**Real Enhanced Super-Resolution Generative Adversarial Networks**, ported to **Next Generation Neural Network (ncnn)** framework with **Vulkan** GPU backend.

This combination delivers high-quality AI-driven image super-resolution with excellent performance on both integrated and discrete GPUs via Vulkan compute shaders.

### Compilation

Compilation has been successfully tested on a **modern Gentoo Linux system** with the following toolchain:

| Component | Version |
|-----------|---------|
| GCC | 15.2 |
| CMake | 4.3.3 |
| Vulkan (headers, tools, loader) | 1.4.341.0 |

The build was validated against **NVIDIA proprietary drivers** (with CUDA support). Vulkan is the primary acceleration backend used at runtime — CUDA itself is not directly required by esrgan-ncnn, but the NVIDIA driver stack must include proper Vulkan support.

#### System Dependencies (Gentoo Linux)

Ensure the following packages are installed before building:

```bash
sudo emerge --ask dev-util/cmake sys-devel/gcc media-libs/vulkan-loader \
    media-libs/vulkan-tools virtual/glshaders
```

Additional Vulkan-related packages may be needed depending on your driver setup (e.g., `x11-drivers/nvidia-drivers` with USE flag `vulkan`).

#### Build Steps

```bash
# Clone with submodules (ncnn library is a submodule)
git clone --recurse-submodules https://github.com/xinntao/Real-ESRGAN-ncnn-vulkan.git
cd Real-ESRGAN-ncnn-vulkan/src

# Configure with CMake
CXXFLAGS="-std=c++17" cmake -S . -B build -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
    -DCMAKE_INSTALL_PREFIX=/usr/local/esrgan-ncnn

# Build using all available cores (adjust -j as needed)
cmake --build build -j$(nproc)

# Install to the configured prefix
sudo cmake --install build
```

The compiled binary will be placed at `/usr/local/esrgan-ncnn/bin/realesrgan-ncnn-vulkan` (or whatever prefix you chose).

> **Note:** If using `ccmake` instead of `cmake`, the interactive TUI allows you to toggle options before generating the build files:
> ```bash
> CXXFLAGS="-std=c++17" ccmake -DCMAKE_POLICY_VERSION_MINIMUM=3.5 -S . -B build
> ```

### Models

The upscaler requires model files (`.param` and `.bin`) to run. You can obtain baseline models from the official release or community-trained ones. See [Choosing the Best Upscaling Model](upscaling-models.md) for detailed recommendations based on source material type.

#### Official Baseline Models

Extract the base models from the official release archive:

```
https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-ubuntu.zip
```

This archive includes several pre-trained models such as `realesrxan-x4plus`, `realesrgan-x4plus-anime`, and others.

#### Community Models (UltraSharp)

For higher-quality results on photographic content, the **4x-UltraSharp** model is recommended:

```bash
wget https://huggingface.co/Kim2091/UltraSharp/resolve/main/NCNN/4x-UltraSharp-fp16.param -O ultrasharp-4x.param
wget https://huggingface.co/Kim2091/UltraSharp/resolve/main/NCNN/4x-UltraSharp-fp16.bin -O ultrasharp-4x.bin
```

Place model files in a dedicated directory (e.g., `/home/user/AI/models/ncnn/`) and reference it via the `-m` flag when running the upscaler.

### Usage

Basic usage of the compiled binary:

```bash
/usr/local/esrgan-ncnn/bin/realesrgan-ncnn-vulkan \
    -g 0 \
    -m /home/user/AI/models/ncnn/ \
    -n 4x-UltraSharp \
    -s 4 \
    -i input.jpg \
    -o output.png
```

| Flag | Description |
|------|-------------|
| `-g <id>` | GPU device ID to use (default: 0) |
| `-m <dir>` | Directory containing model `.param` and `.bin` files |
| `-n <name>` | Model name (without extension, e.g., `4x-UltraSharp`) |
| `-s <scale>` | Upscale factor (e.g., 2, 4, 8) |
| `-i <path>` | Input image path |
| `-o <path>` | Output image path |

### Integration with Wallpaperinho

Set the following configuration properties in `etc/config.js` to enable AI upscaling:

| Property | Description |
|----------|-------------|
| `ncnnUpscalerBin` | Path to the `realesrgan-ncnn-vulkan` binary. Set to `""` (empty string) to disable upsampling. |
| `ncnnUpscalerModelDir` | Directory containing model `.param` and `.bin` files. |
| `ncnnUpscalerModel` | Model name without extension (e.g., `"4xNomos8kSC"`). |
| `ncnnUpscalerScale` | Upscale factor as a string (e.g., `"4"`). |
| `ncnnUpscalerFlags` | Optional free-form string of extra flags (shell-split before input/output args), e.g., `"-g 0"`. |
| `ncnnUpscaleTolerance` | Iterative-upscale stop threshold (default `"0.95"`): passes are chained until both dimensions reach at least this fraction of the target display size. |
| `ncnnMaxUpscalePasses` | Safety cap on chained NCNN passes per display (default `3`). |

The actual command-line arguments are assembled automatically from these properties at runtime via `config.getNcnnUpscalerCommand(inputPath, outputPath)`. You can also override any of these values per-profile in `etc/profiles.js`.

When configured, the image processor will automatically route images through the ncnn upscaler before compositing the final wallpaper.

### Iterative Upscaling

Because each profile pins a **fixed scale factor** (`-s`, matching the model's trained resolution), a single pass is not always enough for small sources: a 512×768 photo assigned to a 2560-wide slot would still be ~25% short after one ×4 pass, leaving ImageMagick to do an ugly stretch.

Wallpaperinho therefore chains NCNN passes **in a loop**: it keeps running the upscaler as long as either dimension is below `ncnnUpscaleTolerance` × target size (default 95%), stopping once ImageMagick only needs to close a small gap during its cover-resize + center-crop step. Each intermediate file is written to the temp directory and cleaned up afterwards; a no-op pass (size did not grow) aborts the chain early, and `ncnnMaxUpscalePasses` caps total GPU work.

Behavior matrix:

| Situation | What happens |
|-----------|--------------|
| Image already ≥ tolerance of both target dims | No NCNN pass at all — straight to fit-exact resize/crop |
| NCNN configured, image smaller than needed | Chained NCNN passes until within tolerance, then ImageMagick closes the ≤5% gap |
| NCNN disabled (`ncnnUpscalerBin: ""`) or binary missing | ImageMagick does the full upscale itself (works, but visibly softer on large gaps) |

> **Tradeoff note:** with the default 0.95 tolerance, even a slight shortfall (e.g., 2400 px wide for a 2560 slot) triggers a full GPU pass producing a much larger intermediate. If that feels wasteful, lower `ncnnUpscaleTolerance` (e.g., `"0.7"`) so NCNN kicks in only when ImageMagick would really struggle.
