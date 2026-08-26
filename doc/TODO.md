# TODO

## Current Tasks

- [ ] Add ability to point to particular seed via CLI or profile, not only random ones
- [ ] Fix log levels - some messages use wrong severity (e.g., warnings logged as info)
- [ ] Support greyscale images - current HSL extraction may produce incorrect results for monochrome images
- [ ] Find best model for upscaling people/portraits (research task)

## LATER

- [ ] Add helper library/libraries for commonly duplicated logic (orientation check: vertical/horizontal/square)
- [ ] Add content selector (AI/NN via PyTorch or js-transformers)

### Consider

- [ ] Add quote generation?
- [ ] Add RGB driving?

---

## Known Issues

| # | Issue | Severity | Status |
|---|-------|----------|--------|
| 1 | findRandomExcluding() doesn't filter by orientation | Low | ⚠️ Confirmed |
| 2 | Aggressive ImageMagick stderr filtering hides real errors | Low | ⚠️ Confirmed |
| 3 | No input validation on display dimensions | Medium | ⚠️ Confirmed |
