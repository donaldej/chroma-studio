# Chroma Studio

A self-hosted editor and radio controller for **DisplayData/ZBD Chroma74** e-ink
displays, running on the **LILYGO T-Embed CC1101 Plus**. The ESP32 hosts the React
interface, stores screens, and sends them through its onboard CC1101. No cloud
account or separate server is needed.

Based on [atc1441's E-Paper_Pricetags access point](https://github.com/atc1441/E-Paper_Pricetags/tree/main/Custom_PriceTag_AccesPoint),
with a new interface, JSON API, persistent library, and onboard controls.

## Features

- Text/image editor with a 640 × 384 preview, font/layout controls, and saved screens.
- Display registry, tag diagnostics, visual confirmation, persistent queue, bounded retries, and cancellation.
- Controller-run schedules and playlists; optional live weather, clock, and JSON data sources.
- Drag-and-drop text, shape, QR, and image layers, plus full checksummed backup/restore.
- Black/white/yellow rendering; both pigment planes are sent to clear old content.
- Controller LCD showing live transfer progress and wheel navigation for sending saved screens.
- Power menu: confirmed shutdown, reboot, and screen off.
- Home Wi-Fi setup through a browser or a local USB setup window.
- Local HTTP API, command-line client, and library backup tools.

## Requirements

The tested hardware is a **LILYGO T-Embed CC1101 Plus** (ESP32-S3, 16 MB flash,
8 MB OPI PSRAM) and a **640 × 384 Chroma74 with black/white/yellow pigment**.
The board contains the radio, LCD, and wheel; no external radio wiring is needed.
Use a USB **data** cable and install batteries in the Chroma74.

Other T-Embed models and shelf labels are not automatically compatible. Chroma74
accent variants use either yellow or red pigment; software cannot add another
physical pigment. This project was tested with the yellow variant. Match your
display's regional radio settings; see [board details](docs/t-embed-cc1101-plus.md).

Install Git and Python 3.10+. Node.js 18+ and npm are needed to build/develop the
React app. Firmware dependencies are pinned in `firmware/platformio.ini`, and
JavaScript dependencies have a lockfile.

## First-time setup

These commands use **PowerShell on Windows**, from the repository root. On
macOS/Linux, use `.venv/bin/python` in place of `.venv/Scripts/python.exe`.

### 1. Clone and install tools

```powershell
git clone https://github.com/donaldej/chroma-studio.git
cd chroma-studio
python -m venv .venv
.venv/Scripts/python.exe -m pip install -r requirements-tools.txt
```

PlatformIO downloads its toolchain and libraries on the first build. Internet
access is needed to install dependencies, but not for normal operation.

### 2. Back up the board

Connect USB, close serial monitors, and identify the board's port:

```powershell
.venv/Scripts/python.exe -m serial.tools.list_ports
New-Item -ItemType Directory -Force backups | Out-Null
```

Replace `COM12` with your port. Use a fresh backup filename; never overwrite your
only original backup:

```powershell
.venv/Scripts/python.exe -m esptool --chip esp32s3 --port COM12 --baud 460800 --after no_reset read_flash 0x0 0x1000000 backups/original-full.bin
.venv/Scripts/python.exe -m esptool --chip esp32s3 --port COM12 --before no_reset verify_flash 0x0 backups/original-full.bin
Get-FileHash backups/original-full.bin -Algorithm SHA256
```

A full 16 MB backup is **16,777,216 bytes**. Confirm a matching digest and keep a
second copy. Backups can contain Wi-Fi credentials and are excluded from Git.
See [rollback instructions](docs/t-embed-cc1101-plus.md#backup-and-rollback).

### 3. Build the browser interface

```powershell
cd ui
npm ci
npm run build
node scripts/build.mjs --deploy
cd ..
```

`--deploy` copies compressed JS/CSS and HTML into `firmware/data/`. Prebuilt web
assets are also included in this repository.

### 4. Build and flash

```powershell
.venv/Scripts/python.exe -m platformio run -d firmware -e t-embed-cc1101-plus
.venv/Scripts/python.exe -m platformio run -d firmware -e t-embed-cc1101-plus -t upload --upload-port COM12
.venv/Scripts/python.exe -m platformio run -d firmware -e t-embed-cc1101-plus -t uploadfs --upload-port COM12
```

Run sequentially. `upload` installs firmware and its embedded web interface;
`uploadfs` initializes filesystem assets for a fresh controller.
**Uploading the filesystem replaces saved screens and display registrations.**
For an existing controller, follow the preservation instructions below.
Application-only uploads preserve the filesystem and saved Wi-Fi settings.

If automatic bootloader entry fails, hold the wheel button (BOOT/GPIO0) while
resetting/reconnecting USB, release it, and retry. The port can change after reset.

### 5. Set up home Wi-Fi

Use a **2.4 GHz** network. Double-click `tools/Connect-HomeWiFi.cmd` on Windows,
or run the Python GUI:

```powershell
.venv/Scripts/python.exe tools/wifi_setup.py
```

Select the controller port, enter Wi-Fi details, and connect. Close other programs
using the serial port. The GUI requires Tk support (normally included with Python
on Windows). It sends credentials directly over USB and shows the assigned IP;
credentials are saved on the controller.

Alternatively, join **Chroma74-Setup** Wi-Fi and open
**http://192.168.4.1/wifi**. After configuring it, reconnect your phone/computer to
your home network. Open the IP shown under **Connection** on the controller.
**http://chroma.local/** also works where mDNS is supported.

### 6. Pair a display and send a screen

1. Open Chroma Studio at the controller's IP address.
2. Add the display using the serial printed on its label. Fresh installations
   start with an empty registry.
3. Select its palette and a unique display ID. Advanced settings include radio
   channel, network ID, and wake-up channel.
4. Activate/pair it and wait for a reply. Regional variants and existing retail
   configurations can require different channel settings.
5. Open **Saved screens**, create a screen, enter text or upload an image, then
   choose **Save & send** and select the display.

Wake/synchronization can take about half a minute; a full two-plane send can take
another minute or more. Follow **Activity** or the controller LCD. Completion is
reported after the display acknowledges the command. E-ink retains its image
without power, so a visible image does not prove the display's batteries work.

## On-device controls

Turn the wheel to browse, press to select, and hold to go back. The side button
returns home. Choose **Displays → display → saved screen**, then confirm to send.
The LCD stays lit and updates progress between radio bursts; wheel input pauses
during transfers and resumes afterward.

The **Power** menu offers **Shutdown**, **Reboot**, and **Turn off screen**.
Shutdown uses deep sleep; the side button powers it back on. Screen off leaves
Wi-Fi/transfers running; either button wakes the screen. USB/charging circuitry
can still draw power during shutdown.

## API and command line

The local JSON API is under `/api/v1`. Set the controller address or supply
`--controller http://<controller-ip>` to each Python tool:

```powershell
$env:CHROMA_CONTROLLER = 'http://<controller-ip>'
.venv/Scripts/python.exe tools/studio.py state
.venv/Scripts/python.exe tools/studio.py presets
.venv/Scripts/python.exe tools/studio.py send YOUR_DISPLAY_SERIAL YOUR_PRESET_ID --wait
.venv/Scripts/python.exe tools/backup_studio.py --output backups/my-library
```

The default is `http://chroma.local`. `GET /api/v1/state` returns controller,
device, screen, and job data. `POST /api/v1/jobs` accepts
`{"serial":"YOUR_DISPLAY_SERIAL","preset":"YOUR_PRESET_ID"}`.
See [API and usage notes](docs/studio.md) for the full reference.

The HTTP API has no authentication: use a trusted local network and do not expose
it directly to the internet. Battery percentage and continuous tag-online status
are not measured. Limits: 12 displays, 20 saved screens, eight pending
actions/transfers, and 12 recent jobs. The last 12 jobs, library, and registry persist across reboot.

## Schedules, layouts, and live data

Studio 0.4 adds [radio measurements, image history and Home Assistant/MQTT](docs/radio-history-mqtt.md).
Studio 0.3 introduced a Diagnostics page, persistent transfer recovery, schedules,
playlists, a visual layout editor, and full library backup/restore. Brightness
and screen timeout live in Settings. The optional local companion renders weather,
clock/date, calendar notices, Home Assistant, and other JSON-fed templates.
See the [feature setup and API guide](docs/features.md) for configuration and limits.

## Updating an existing controller

Studio 0.5 adds [image preparation and browser firmware updates](docs/updates-and-images.md).
After installing 0.5 once over USB, use **Settings → Firmware updates** with a
`.chroma` package. Application and interface update together while library and
Wi-Fi data stay in place. The guide includes package creation, previous-app
switching, and USB recovery that resets the OTA boot selector correctly.

For Studio 0.5+, prefer browser packages. If using USB after OTA, follow the
recovery helper instructions so app0 is selected correctly; a normal PlatformIO
upload alone may leave app1 selected. For older controllers, firmware-only
changes can use application upload without `uploadfs`.
For controllers older than 0.5, a frontend update needs a filesystem update:

```powershell
.venv/Scripts/python.exe tools/backup_studio.py --controller http://<controller-ip> --output backups/before-update
.venv/Scripts/python.exe tools/stage_library.py backups/before-update
.venv/Scripts/python.exe -m platformio run -d firmware -e t-embed-cc1101-plus -t uploadfs --upload-port COM12
.venv/Scripts/python.exe tools/stage_library.py backups/before-update --clean
```

Use a new backup directory each time. Backups include metadata **and all referenced
assets**; metadata export alone is insufficient. Staging puts the library into
the filesystem image. Cleanup removes only matching staged files locally and
does not delete files on the board. Run PlatformIO targets sequentially.

## Development and tests

```powershell
cd ui
npm ci
npm run build
npm test
npx playwright install chromium
node tests/browser.mjs
node tests/features-browser.mjs
node tests/companion.mjs
$env:CHROMA_CONTROLLER = 'http://<controller-ip>'
npm run dev
```

The dev server runs at **http://127.0.0.1:5173** and proxies API requests to your
controller. Packet tests and the mocked desktop/mobile browser test need no
display. Set `CHROMA_BROWSER_PATH` to use an existing browser executable instead
of Playwright Chromium.

Live tests send real images. `ui/tests/hardware.mjs` requires `CHROMA_SERIAL`,
edits the Hello Studio sample, and sends it. This Python check resends the current
saved image and verifies changing LCD progress and display acknowledgement:

```powershell
.venv/Scripts/python.exe tools/test_controller_progress.py --controller http://<controller-ip> --serial YOUR_DISPLAY_SERIAL --output artifacts/progress-test.json
```

The feature check exercises a bounded timeout, optional USB restart recovery,
one-time scheduling, and a two-screen playlist. It sends real images, then
restores the selected final preset and removes its temporary plans:

```powershell
.venv/Scripts/python.exe tools/test_studio_features.py --controller http://<controller-ip> --serial YOUR_DISPLAY_SERIAL --test-preset TEST_PRESET_ID --final-preset FINAL_PRESET_ID --reset-check --port COM12 --output artifacts/features-test.json
```

`ui/tests/preview.mjs` is a local regression check requiring separately captured
snapshots in `backups/studio-final/`; these private snapshots are not distributed.
Firmware/frontend builds, packet/browser tests, black/yellow physical transfers,
and live LCD progress have passed on the tested board.

## Troubleshooting

- **No USB port:** try a data cable, close serial tools, and recheck the port after BOOT mode.
- **Page will not load:** use the numeric IP shown under **Connection**. Keep both
  devices on the same LAN and check guest-network/client isolation settings.
- **No display reply:** check batteries, serial, display ID, regional wake channel,
  and radio channel. A retained image does not prove the tag is powered.
- **Missing web interface:** rebuild/deploy React assets before building firmware.
  Studio 0.5 embeds the interface in the application; older versions need `uploadfs`.
  Back up existing screens before replacing a used controller's filesystem.
- **Old API calls fail:** Studio uses `/api/v1`; `/set_custom` and `/edit` belong
  to the legacy interface.

## Layout and credits

| Directory | Contents |
| --- | --- |
| `firmware/` | PlatformIO firmware, bundled libraries, and deployed web assets |
| `ui/` | React/TypeScript editor, encoder, and tests |
| `tools/` | USB setup, API client, backups, and live checks |
| `docs/` | Board/API instructions and upstream protocol notes |
| `samples/` | Upstream Chroma74 BMP planes |

Backups, build artifacts, logs, credentials, installed dependencies, and reference
checkouts are excluded from Git. The historical ESP32 environment is retained but
is not the tested Studio target. Some legacy tools target only the old API.

Derived from upstream commit `5ac32ec28b03c9265a9b34ad54de8daa79a5f21b`.
Hardware mappings follow [LILYGO's T-Embed-CC1101 reference](https://github.com/Xinyuan-LilyGO/T-Embed-CC1101).
Licensed under **GPL-3.0**; see [LICENSE](LICENSE). Bundled third-party libraries
retain their notices and licenses.
