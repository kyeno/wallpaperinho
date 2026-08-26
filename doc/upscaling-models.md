## Choosing the Best Upscaling Model for Your Needs

The quality of AI upscaling depends heavily on selecting the right model for your source material. This document provides guidance based on image type and content characteristics.

### Where to Get Models

In addition to official and community sources listed in [upscaling.md](upscaling.md), a large curated collection is available from the Upscayl project:

```bash
wget https://github.com/upscayl/custom-models/archive/refs/heads/main.zip
unzip main.zip
```

This archive contains dozens of pre-trained ncnn models covering photography, anime, line-art, and specialized use cases.

---

### Low-Resolution, Grainy, or Compressed Images

If your wallpaper directory consists of rather low-res, grainy images - for example, Facebook-downloaded "Liminal Spaces" or Pictorialism photos - finding the right model may require experimentation. The following are general recommendations ranked by suitability:

#### 1. `4xNomos8kSC` - **Best for Compressed Web Photography**

This is the exact model you want for this specific job.

**What it is:** Trained by community legend Philip Hofmann using a massive dataset of high-fidelity photography (Nomos8k), explicitly utilizing an On-The-Fly (OTF) JPEG degradation pipeline.

**Why it's perfect here:** It was built precisely to take compressed web photos, remove square JPEG macroblocks, and restore smooth gradients and realistic photographic textures. It handles grain elegantly without scrubbing away the haunting atmospheric depth that liminal spaces and pictorialism depend on.

#### 2. `ultrasharp-4x` - **Community Gold Standard**

The community gold-standard general photography model. It strikes a flawless balance between removing compression artifacts and maintaining sharp geometric lines (like corners, doors, and long corridors in liminal architecture). It is a highly safe, highly reliable default.

#### 3. `4x_NMKD-Superscale-SP_178000_G` / `4x_NMKD-Siax_200k` - **Texture Preservation Specialists**

The NMKD models are legendary for texture preservation. If your image has a lot of film grain, concrete texture, carpets, or mist, NMKD models focus on reconstructing those micro-details rather than just smoothing everything over. Use these when you want to preserve or enhance surface detail instead of producing clean, polished output.

---

### Cartoon / Anime Specialized Models

For illustrated content, anime screenshots, manga pages, or cartoon-style artwork, use models specifically trained on line-art and cel-shaded imagery:

| Model | Description |
|-------|-------------|
| `4xHFA2k` | High-fidelity anime upscaler; excels at preserving clean line-art while boosting resolution |
| `realesrgan-x4plus-anime` | Official anime-tuned model from the Real-ESRGAN project |
| `4xNomosAnime` | Philip Hofmann's anime variant; good balance between sharpness and artifact removal |

These models will produce noticeably better results on drawn content than photography-oriented ones, as they are tuned to handle flat color regions and crisp edges without introducing unwanted noise or halos.

---

### Pristine / Already Sharp Images

If your source images are already high-quality and you simply need more pixels (e.g., for fitting a large display), use:

#### `4xLSDIR` - **Lossless-Style Directional Upscaler**

Designed for clean, already-pristine images. LSDIR focuses on directional interpolation that preserves existing sharpness without adding artificial texture or hallucinating detail. Use this when you want faithful enlargement without stylistic changes.

---

### Quick Reference Table

| Source Material | Recommended Model(s) |
|----------------|---------------------|
| Compressed web photos, JPEG artifacts | `4xNomos8kSC` → `ultrasharp-4x` → NMKD variants |
| Grainy film-style, textured surfaces | NMKD (`Superscale-SP`, `Siax_200k`) |
| General photography (safe default) | `ultrasharp-4x` |
| Anime, manga, cartoons | `4xHFA2k`, `realesrgan-x4plus-anime` |
| Already-sharp, pristine images | `4xLSDIR` |

> **Tip:** When in doubt, start with `4xNomos8kSC` for photographic content or `ultrasharp-4x` as a universal fallback. Run test upscales on representative samples before committing to full wallpaper generation runs.