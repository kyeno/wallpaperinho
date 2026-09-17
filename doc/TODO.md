# TODO

## Current Tasks

- [ ] Recommend using "gallery-dl" and some FB profiles for images,
      https://github.com/mikf/gallery-dl

      https://www.facebook.com/KenopsiaLux/photos
      https://www.facebook.com/huleeb/photos
      https://www.facebook.com/MariuszLewandowskiART/photos
      https://www.facebook.com/NocturnalAddiction/photos

- [ ] Add ability to point to particular seed via CLI or profile, not only random ones
- [ ] Fix log levels - some messages use wrong severity (e.g., warnings logged as info)
- [ ] Support greyscale images - current HSL extraction may produce incorrect results for monochrome images
- [ ] Find best model for upscaling people/portraits (research task)

## LATER

- [ ] Add helper library/libraries for commonly duplicated logic (orientation check: vertical/horizontal/square)
- [ ] Add content selector (AI/NN via PyTorch or js-transformers)
- [ ] Automatically store debug information in EXIF of the generated file

### Consider

- [ ] Add quote generation?
- [ ] Add RGB driving?
- [ ] Create custom filters/compositors, f.e. GTA-like images

---

## Known Issues

| # | Issue | Severity | Status |
|---|-------|----------|--------|
| 1 | findRandomExcluding() doesn't filter by orientation | Low | ⚠️ Confirmed |
| 2 | Aggressive ImageMagick stderr filtering hides real errors | Low | ⚠️ Confirmed |
