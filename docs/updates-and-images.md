# Image preparation and browser firmware updates

## Preparing photos and logos

Choose **Saved screens → Create a screen → Image**, then choose an image.
The preparation window opens before the image enters your screen design.
Existing image screens have a **Prepare image** button. Layout image layers have
**Prepare layer image** after an image is selected.

The window provides:

- Rotation in 90-degree steps; rotating resets the crop to the full image.
- A crop guide with left/top/width/height percentages of the rotated image.
- **Fit whole crop** (white margins) or **Fill the screen** (centered crop to fill).
- Brightness and contrast controls.
- Black/white/yellow or black/white-only conversion.
- No dithering for clean logos, error diffusion for photos, or an ordered dot pattern.

The output preview uses the display's encoded colors. Grayscale pixels remain
black/white under dithering rather than acquiring yellow fringes. Transparency
is composited on white. The crop guide is not sent to the display.
**Use prepared image** applies the preview; cancel keeps the previous image.
The normal **Save screen** / **Save & send** buttons then save/send it.

Preparation is destructive only to the draft's pixel result, not your source file.
The library stores the final display-resolution packet, not the original photo
or an editable filter recipe. Keep the original file to make future changes from
its full quality. Full-screen uploads are limited to 10 MB and 40 megapixels;
intermediate preparation canvases are limited to 2048 pixels per side.
The Chroma74's three pigments remain fixed; dithering simulates tones with dots
and does not add physical colors. Current previews use the black/white/yellow palette.

## Browser firmware installation

The first installation of Studio 0.5 must use USB. It adds the updater and embeds
the React interface in the application. Later `.chroma` packages update the
application and web interface together, without replacing SPIFFS or NVS.
Saved screens, image history, schedules, settings and Wi-Fi credentials remain.
Back up your library before upgrades, especially when moving between versions.

Build a package from the workspace root:

```powershell
cd ui
npm ci
npm run build -- --deploy
cd ..
$env:PLATFORMIO_CORE_DIR = Join-Path (Get-Location) '.platformio'
.venv/Scripts/python.exe -m platformio run -d firmware -e t-embed-cc1101-plus
.venv/Scripts/python.exe tools/package_firmware.py firmware/.pio/build/t-embed-cc1101-plus/firmware.bin --output artifacts/chroma-studio.chroma
```

The build embeds `firmware/data/index.htm`, `app.js.gz`, and `app.css.gz` in the
application. Always rebuild/deploy the React assets before building firmware
when the interface changes. No filesystem upload is needed for web changes on
Studio 0.5+. The filesystem still holds display assets and library metadata.
The package helper also writes a JSON manifest with the application SHA-256.

Open **Settings → Firmware updates → Choose firmware package**. Select the
`.chroma` file, review its version/size/checksum and choose **Install update**.
The controller must have no active or queued transfers. Finish/cancel transfers
first; background synchronization beacons can pause for the installation.
Keep power connected and the browser open while uploading and reconnecting.

Both browser and controller check package format, board target, ESP32-S3 chip,
slot size, exact application length, embedded UI/version marker and SHA-256.
The ESP32 then validates the application image. Raw `.bin` files, full-flash
backups, filesystem images and packages for another board are rejected.
These checks detect incompatibility/corruption, not publisher authenticity:
install only firmware you built or otherwise trust.

The application is written to the inactive OTA slot (`app0` or `app1`). Uploading
alone does not select it for boot. Only a complete, verified upload receives a
commit token, and commit selects the new slot and restarts. The browser verifies
the new version and changed running slot after reconnecting. Refresh afterward
to load the new embedded interface. An interrupted upload leaves the current
application selected. Abandoned uploads expire after 30 seconds of inactivity;
verified but uncommitted uploads expire after two minutes.

Radio/UI actions, new transfers, library mutations and Wi-Fi changes are blocked
during installation. Existing automations resume after the update/restart.
The controller's local screen may retain its last view while the web page shows
upload progress; local wheel/power actions are paused during flashing.

ESP32 A/B application updates provide protection during upload. This build's
bootloader does **not** enable automatic crash rollback. Do not assume that a
new application which boots but cannot connect will revert by itself. See the
official [ESP32-S3 OTA documentation](https://docs.espressif.com/projects/esp-idf/en/stable/esp32s3/api-reference/system/ota.html)
for the distinction between application slots and bootloader rollback support.

## Previous application and USB recovery

If the controller is reachable, open **Recovery and previous firmware → Use
previous firmware** to restart into the other compatible application. This
becomes available after an OTA install leaves a valid application in both slots.
It changes software only; it does not roll back shared library data. Back up data
before switching between versions with different data formats.

If it cannot boot/connect, use a USB data cable. If needed, hold BOOT while
connecting USB, then release BOOT. Use the project virtual environment:

```powershell
.venv/Scripts/python.exe tools/recover_firmware.py --port COM12 --firmware artifacts/studio-05/firmware.bin
```

Use a standalone Studio 0.5+ `firmware.bin`, not a `.chroma` package. The
path above is the release copy in this workspace; adjust it to your downloaded
binary or `firmware/.pio/build/t-embed-cc1101-plus/firmware.bin` after building.
The recovery helper validates the chip/board marker, writes only `app0` at `0x10000`, then
erases only the OTA selector at `0xe000` (8192 bytes) so the bootloader chooses
app0. It preserves NVS, SPIFFS, bootloader and the partition table. This selector
step matters after OTA: a normal PlatformIO USB upload writes app0 but may leave
app1 selected. Avoid full-chip erasure and unnecessary filesystem uploads.
The factory full-flash backup remains a separate last-resort recovery option.

## API and verification

Studio 0.5 pins the vendored TCP transport to ESP32Async/AsyncTCP v3.3.2 for
upstream queue-congestion and connection-lifecycle fixes needed by uploads.
The radio task stays on core 1; network callbacks remain on core 0 with the
previous 16 KB stack and priority 3. See `firmware/lib/AsyncTCP/UPSTREAM.md`.

| Endpoint under `/api/v1` | Purpose |
| --- | --- |
| `GET /firmware` | Version, board marker, slot sizes, running/update slot, upload state and previous-app availability |
| `POST /firmware/upload` | Multipart `.chroma` file; returns commit token after complete verification |
| `POST /firmware/commit` | JSON `{ "token": "..." }`; selects verified app and restarts |
| `POST /firmware/rollback` | JSON `{}`; selects previous compatible app and restarts |

All firmware POSTs require `X-Chroma-Update: 1`. Uploads use one multipart file.
Read-only API calls remain available during update. Neither the token nor the
target/checksum markers are a replacement for authenticated access on an
untrusted network; keep the existing trusted-LAN deployment model.

From `ui/`, `npm test` covers pigment conversion/dithering and firmware package
preflight. `node tests/preparation-browser.mjs` covers image controls, saved
packet colors, mobile layouts, invalid package rejection, commit/reconnect and
previous-application controls. `python tools/test_firmware_package.py` runs
offline package/recovery-address checks from the workspace root. Live rejection
checks write only the inactive application slot and never commit:

```powershell
.venv/Scripts/python.exe tools/test_firmware_upload.py --controller http://<controller-ip> --package artifacts/chroma-studio.chroma --output artifacts/ota-rejections.json
```

For a complete browser-driven live installation, set `CHROMA_CONTROLLER` and
`CHROMA_FIRMWARE_PACKAGE` before running `node tests/firmware-hardware.mjs` from
`ui/`. Set `CHROMA_OTA_ROLLBACK=1` to test previous-application switching and
reinstall the chosen package afterward. This restarts the real controller.
`node tests/image-hardware.mjs` briefly saves/removes a prepared-image test screen
on the controller without requesting a radio transfer.
