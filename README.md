# Wallpaperinho ⚽

![TypeScript-Free](https://img.shields.io/badge/TypeScript-free-ff69b4?style=flat-square)

> This is a TypeScript-free project. Stop JavaScript pollution! 
> Built with pure, modern, native JavaScript.

Wallpaperinho is a programmatic, service-oriented desktop wallpaper automation tool built specifically for multi-monitor setups and **data hoarders** who maintain massive offline directories of legacy images, high-res artwork, or scraped digital archives. 

It recursively indexes your image assets, handles change detection, classifies them by orientation, and stores the metadata in an isolated local SQLite catalog. Using advanced matching pipelines (including a multi-dimensional `gemini` composite scorer), it picks the perfect visual harmony for your screen layout, applies AI-driven Vulkan super-resolution upscaling if source assets are too small, crops them cleanly, and composites them via ImageMagick into a single unified desktop canvas.

The project name and the startup ASCII art are affectionately inspired by a certain legendary Brazilian soccer player's famously charismatic, crooked face.

---

## 🖥️ Multi-Monitor Compositing Paradigm

Wallpaperinho calculates exactly how to cut and join your wallpapers based on your physical monitor placement. For example, a classic asymmetric PLP (Portrait-Landscape-Portrait) setup aligned along the bottom desk line:

```text
  +-----------+   +-------------------+   +-----------+
  |           |   |                   |   |           |
  | 1080x1920 |   |                   |   | 1080x1920 |
  |   23"     |   |     2560x1600     |   |   23"     |
  |  Portrait |   |        30"        |   |  Portrait |
  |  (Left)   |   |     Landscape     |   |  (Right)  |
  |           |   |     (Center)      |   |           |
  |           |   +-------------------+   |           |
  +-----------+---------------------------+-----------+
  ================= DESK LINE (bottom) ================
```

### Desktop Environment Support

| Environment | Status |
|-------------|--------|
| **Cinnamon** | ✅ Fully tested & native |
| GNOME | ⚠️ Experimental (untested) |
| KDE Plasma | ⚠️ Experimental (untested) |
| XFCE | ⚠️ Experimental (untested) |
| Hyprland | ⚠️ Experimental (untested) |

Wallpaper management for non-Cinnamon environments is provided on a best-effort basis via `WallpaperSetter`. If your DE automation fails, the script safely falls back to printing the final composite image path so you can apply it manually.

---

## 🛠️ Requirements

### Runtime Dependencies
- **Node.js** >= 22.5.0 (utilizes native `node:sqlite` and `node:worker_threads` modules)
- **ImageMagick** >= 7.x

### Optional Hardware Acceleration
- **Real-ESRGAN-ncnn-vulkan** (optional, for high-quality AI super-resolution). Requires a functional Vulkan driver stack (e.g., NVIDIA proprietary drivers or Mesa with Vulkan support).

---

## 💾 Built for Data Hoarders & Automation

Wallpaperinho is designed to be lean, relying heavily on Node.js built-in modules to avoid unnecessary dependency bloat. Because it indexes file parameters natively into local SQLite databases, it easily manages directories containing tens of thousands of images.

It can easily be thrown into a `crontab` to periodically cycle wallpapers, though keep in mind it will briefly wake up your CPU/GPU hardware if AI upscaling or intense ImageMagick multi-tiling operations are triggered. Cron jobs start without any display-session environment (`XDG_CURRENT_DESKTOP`, `DISPLAY`, ...), which is normally injected by the display manager at graphical login -- `bin/wallpaperinho` detects this and transparently inherits those variables from your active GUI session before launching Node, so plain crontab entries work out of the box (see [Running Under Cron](#running-under-cron)).

---

## ⚙️ Configuration

Configuration is split into two cleanly separated files located inside the `etc/` directory:
1. **`config.js`**: The base configuration layer exported as a plain JavaScript object using standard **camelCase** keys. It establishes system defaults, display dimensions, tolerances, and upscaler paths.
2. **`profiles.js`**: Profile-specific overrides. You can define various named presets (e.g., `liminal`, `anime`). When no `--profile` flag is passed, one eligible profile is picked at random (consecutive runs rotate away from the previously used one); pin any specific preset with `--profile <name>` (`default` selects the first/implicit-default profile). A profile may opt out of the random pool by setting `"excludeFromRandom": true`.

At runtime, the effective settings are resolved dynamically using a strict hierarchy:
**Base Config (`config.js`) ➔ Selected Profile Overrides ➔ CLI Argument Overrides**

Note that `--directory` only replaces the selected profile's `imageDirectories` -- strategies, upscaler model/args and other profile settings still apply.

### Core Settings Reference

| Key | Type | Description | Default |
|-----|------|-------------|---------|
| `debugOverlay` | `boolean` | Renders a diagnostic text overlay on images during processing | `false` |
| `displays` | `[number, number][]` | Monitor resolutions configured left-to-right as `[width, height]` tuples | `[[1080, 1920], [2560, 1600], [1080, 1920]]` |
| `monitorAlignment` | `"top" \| "bottom" \| "center"` | Vertical alignment strategy for mixed-size displays | `"bottom"` |
| `wallpaperOutputDirectory` | `string` | Directory where final composite wallpapers are saved | `"/home/kyeno/Pictures/Wallpapers/"` |
| `tempDirectory` | `string` | Location for temporary processing artifacts | `"/tmp/wallpaperinho"` |
| `imagickBin` | `string` | Direct path to your ImageMagick v7+ binary | `"/usr/bin/magick"` |
| `imageMatchingStrategy` | `string \| string[]` | Active image selection strategy or an ordered array for chain filtering | `"gemini"` |
| `imageDirectories` | `string[]` | Directories recursively scanned for source graphics | *(Profile-specific)* |
| `imageDirectoryExclusions` | `string[]` | Directory basenames skipped during recursive scanning (and excluded as exclusive-mode candidates) | `["lowres", "_exclude"]` |
| `imageSubdirectoryMode` | `"include" \| "flat" \| "subdirsOnly" \| "exclusiveFlat" \| "exclusiveDeep"` | Subdirectory driving mode -- narrows the **selection pool** relative to roots without touching indexing/catalogs; falls back to `include` when no eligible subdirectories exist | `"include"` |

💡 Tip: For advanced algorithmic fine-tuning (like tweaking Canny edge detection steps or HSL distance multipliers), directly inspect the inline JSDoc documentation inside `etc/config.example.js`.

---

## 🎯 Image Matching Strategies

The `imageMatchingStrategy` parameter controls how the engine queries your image repository. It supports both standalone routing and **Chain Mode** (filtering candidates through a sequence of mathematical criteria before making a final count-based selection).

### Available Algorithmic Selectors
- `random`: Pure random selection without constraints.
- `colorHSL`: Computes and matches candidates based on minimal squared HSL color space distance.
- `colorPalette`: Utilizes a dominant-color palette similarity check using a weighted nearest-color algorithm.
- `contrast`: Selects images based on statistical contrast ratio proximity.
- `canny`: Matches edge complexity using calculated Canny edge density profiles.
- `entropy`: Filters by spatial entropy (ImageMagick native metric after 5x5 StandardDeviation) to match structural noise and detail density.
- `gemini`: A multi-dimensional composite scorer balancing palette harmony, brightness alignment, saturation depth, and contrast scaling (meticulously co-authored with Gemini itself!).

### Example: Chain Mode Configuration
```javascript
// Intermediate passes narrow the pool down by tolerance; the final pass selects the exact count.
imageMatchingStrategy: ["contrast", "colorHSL"]
```

---

## 🚀 AI Upscaling Integration

For low-resolution, high-compression web photography (such as old forum dumps, liminal spaces, or pictorialism), Wallpaperinho integrates directly with **esrgan-ncnn-vulkan**. 

For comprehensive documentation on compilation, setups, and selecting the right neural models for your graphics, see the dedicated guides:
- 📖 [AI Upscaling Compilation & Setup Guide](./doc/upscaling.md)
- 📖 [Choosing the Best Upscaling Model](./doc/upscaling-models.md)

### Quick Model Selection Strategy
- **Compressed Web Graphics / JPEG Artifacts**: `4xNomos8kSC` (Excellent at destroying macroblocks while preserving grain).
- **Universal Photographic Default**: `ultrasharp-4x` (Maintains clean structural lines and geometric accuracy).
- **High Texture Retention**: `4x_NMKD-Superscale-SP_178000_G` (Avoids plastic-looking smoothing; preserves film grain and concrete textures).
- **Illustrated Art / Anime**: `4xHFA2k` or `realesrgan-x4plus-anime` (Tuned specifically for cel-shaded line art).

To toggle upscaling, map the binaries in `etc/config.js`:
```javascript
ncnnUpscalerBin: "/usr/local/esrgan-ncnn/bin/realesrgan-ncnn-vulkan",
ncnnUpscalerModelDir: "/home/kyeno/AI/models/ncnn/",
ncnnUpscalerModel: "4xNomos8kSC",
ncnnUpscalerScale: "4"
```
*Set `ncnnUpscalerBin: ""` to completely bypass the upscaling pipeline.*

---

## 📥 Execution & Basic Usage

Wallpaperinho runs directly via the binary shell wrapper inside the root directory:

### Subcommands & Automation
Standard execution (picks a random eligible profile with rotation awareness, re-indexes designated source trees using all available hardware cores, then maps tiles):
```bash
./bin/wallpaperinho
```

Pin one specific profile instead of letting it rotate (`default` = first profile in `profiles.js`):
```bash
./bin/wallpaperinho --profile "liminal"
./bin/wallpaperinho --profile default
```

Bypass directory filesystem checking completely and instantly generate a wallpaper using the cached DB catalog (ideal for cron tasks):
```bash
./bin/wallpaperinho --noindex --profile "liminal"
```

Wipe the catalog metadata completely and force a cold, aggressive re-index from scratch:
```bash
./bin/wallpaperinho --recreate
```

Targeted directory automation with custom strategy routing (`--directory` replaces only the selected profile's image directories -- its strategies/upscaler settings still apply):
```bash
./bin/wallpaperinho --directory "/path/to/my/images" --strategy "gemini" --debug
```

Unattended mode -- warnings and errors are still shown (sized for cron mail capture) plus explicit random-profile selection, ideal for crontab:
```bash
./bin/wallpaperinho --cron
# equivalent to: ./bin/wallpaperinho --silent --random
```

### Running Under Cron

Wallpaperinho is designed to run unattended. Because cron starts jobs with a minimal environment, `bin/wallpaperinho` detects when display/session variables are missing and inherits them from one of your own processes belonging to an active GUI session (read via `/proc/<pid>/environ`). A plain entry like this just works -- no wrapper scripts or manual exports required:

```cron
# Rotate through all eligible profiles quietly (warnings+errors stay visible in cron mail):
*/30 * * * * /path/to/wallpaperinho/bin/wallpaperinho --noindex --cron

# ...or pin one specific profile + directory pair:
*/5 * * * * /path/to/wallpaperinho/bin/wallpaperinho --noindex --profile liminal --directory "/path/to/images"
```

Notes:
- Variables already set in the calling environment always take precedence over auto-inheritance -- e.g., prefixing a crontab line with `export XDG_CURRENT_DESKTOP=X-Cinnamon;` pins the desktop explicitly.
- If multiple graphical sessions are logged in simultaneously, the first one found wins.
- Overlapping runs are guarded by an exclusive lock (`flock`): if a previous instance is still processing (e.g., AI upscaling outlives your cron interval), new invocations log a notice (suppressed under `--silent`/`--cron`) and exit cleanly instead of corrupting shared temp files or catalog state.
- The wrapper needs `node` reachable through cron's default `PATH` (`/usr/bin:/bin`) -- if you manage Node via nvm/asdf/mise, use the absolute path to the binary or export `PATH` inside the crontab line.

### Broken Image Quarantine

Images that exist on disk but cannot be decoded by ImageMagick (truncated copies, corrupt files) are moved out of your library so they stop failing every indexing/generation cycle, and their catalog rows are dropped. Enabled by default (`quarantineBrokenImages: true`).

- Destination defaults to `~/Pictures/Quarantined`; override with `quarantinedImagesDirectory`. Name collisions get `<unixtime>_<name>` suffixes.
- Only files inside your configured image directories are ever moved; cross-device moves fall back to copy+remove.
- During generation an unreadable pick is quarantined and the next-best candidate takes its place automatically (self-healing).
- Disable entirely with `"quarantineBrokenImages": false` in config or profile.

---

## 🏗️ Architecture Details

Wallpaperinho runs a completely synchronous initialization tree spinning out into asynchronous multi-threaded workers:
- **DI Composition Root**: Managed cleanly via `src/main.js`.
- **Worker Isolation**: Directory parsing and expensive metadata routines (Canny math, HSL extraction, entropy calculation) run inside individual threads (`src/workers/imageIndexerWorker.cjs`). The pool size automatically scales to match your system's `$(nproc)` hardware footprint (e.g., handles parallel indexing on massive multi-core rigs).
- **Isolated Catalogs**: Databases are written to `var/db/images-{hash}.sqlite3`. The `hash` value is an 8-character SHA-1 digest computed from your sorted source directories list. Changing target paths automatically generates a clean isolated catalog without database pollution.

```sql
CREATE TABLE IF NOT EXISTS images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT UNIQUE NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  filesize INTEGER NOT NULL,
  hue INTEGER,           -- 0-360
  saturation INTEGER,    -- 0-100
  lightness INTEGER,     -- 0-100
  contrast INTEGER,      
  entropy REAL,          -- ImageMagick entropy after 5x5 StdDev
  canny INTEGER,         -- Edge density metric
  palette TEXT           -- Dominant color JSON array
);
```

---

> ⚠️ **Disclaimer & Maintenance Note:**  
> This application was urgently half-vibecoded by an old-school hacker acting as the project architect, guiding both Gemini and a locally-hosted Qwen model to bypass the tediousness of writing boilerplate and documentation. By design, it **may not always auto-prune legacy composite wallpaper outputs or deep temporary cache directories**. Remember to clean up your temporary workspace manually from time to time to avoid unnecessary disk clutter.
