# Chroma Studio

The T-Embed hosts the React interface itself. Open `http://<controller-ip>/`
(or `http://chroma.local/` when your network supports mDNS). No separate server
or internet connection is needed. Wi-Fi setup remains available at `/wifi` and
through `tools/Connect-HomeWiFi.cmd` over USB.

## Browser and wheel

Create text or image screens in **Saved screens**, preview the actual 640 × 384
pixels, and save or send them to a registered display. This Chroma74 uses black,
white, and yellow pigment. The preview approximates its physical yellow.

On the T-Embed, turn the wheel to browse and press to select. Choose **Displays**,
your display, a saved screen, then confirm the send. Hold the wheel button to go
back; the side button returns home. During a transfer the LCD stays lit and shows
progress, updating small regions between radio bursts. Wheel input pauses to
protect radio timing. Controls resume when the job finishes; live progress and
cancellation remain available in the browser. Activity shows the shared queue;
Network shows the controller's IP address. Saved screens remain available when
the browser is closed.

The home menu's **Power** entry offers **Shutdown**, **Reboot**, and **Turn off
screen**. Shutdown and reboot require a second press to confirm and are blocked
while transfers are pending. Shutdown disables the peripheral rail and puts the
ESP32 into deep sleep; press the side button to start it again. USB and charging
circuitry can still draw power. Screen off sleeps only the LCD, leaving Wi-Fi
and transfers running. Press the wheel or side button to wake it; that first
press does not select a menu item. The Chroma74 retains its image in every case.

## API and command line

All endpoints are local HTTP under `/api/v1`. JSON writes use
`Content-Type: application/json`; accepted operations return HTTP 202. Poll state
to observe completion. Transfers execute sequentially in the radio's main loop.

| Method | Path | Purpose / body |
| --- | --- | --- |
| GET | `/state` | Controller, displays, presets, and jobs |
| GET | `/displays`, `/presets`, `/jobs` | Individual collections |
| POST | `/displays` | Save `serial`, `name`, `id`, `palette`, `channel`, `network`, `wake_channel` |
| POST | `/displays/activate` | Pair: `{"serial":"JM00000000B"}` |
| POST | `/displays/inspect` | Read-only query: `{"serial":"YOUR_SERIAL","query":"panel"}` |
| POST | `/displays/delete` | Remove registry entry: `serial` |
| POST | `/assets` | Multipart `data` file named `<unique-id>.bin` |
| GET | `/assets/<id>` | Download a saved display command |
| POST | `/presets` | Save `id`, `name`, `asset`, and editor fields |
| POST | `/presets/delete` | Delete saved screen: `id` |
| POST | `/jobs` | Send: `{"serial":"JM00000000B","preset":"<preset-id>"}` |
| POST | `/jobs/cancel` | Cancel queued or active transfer: `id` |
| GET | `/export` | Export registry/editor metadata; excludes image binary assets |

`tools/studio.py` provides `state`, `displays`, `presets`, `jobs`, `send`, `cancel`,
`activate`, and `inspect` commands. For example:

```powershell
.\.venv\Scripts\python.exe tools/studio.py presets
.\.venv\Scripts\python.exe tools/studio.py send JM00000000B <preset-id> --wait
.\.venv\Scripts\python.exe tools/studio.py inspect JM00000000B panel --wait
.\.venv\Scripts\python.exe tools/backup_studio.py
```

Limits: 12 displays, 20 saved screens, eight pending actions/transfers, and 12
recent jobs. Recent jobs, screens, registry, and automations persist in SPIFFS. See [Studio 0.3 features](features.md) for recovery, schedules, layouts, and live data.

Read-only inspection queries support `identity`, `panel`, `firmware`, and
`updates`. They use the normal radio queue and return a job ID; the completed
job includes `query` and raw colon-separated hexadecimal `reply`. These commands
do not change tag settings or refresh its image. A transport acknowledgement is
not proof that an image was physically displayed.
Progress reports protocol bytes remaining; completed means the controller received
the display acknowledgement. Battery percentage and continuous display online
status are not measured by this implementation. The existing radio protocol is
retained. Text rendering and raw two-plane encoding run in the browser, avoiding
the old HTTP-callback compression path.

Each send reserves burst timing for the radio, then runs the protocol's wake and
synchronization sequence before starting the transfer. Allow roughly
half a minute for that preparation. `tools/backup_studio.py` downloads metadata
and all referenced screen binaries with a checksum manifest; it creates a new
backup directory on every run.

Full LCD redraws are restricted to the middle of an idle radio slot, including a
check for pending mode changes. During sends, small progress redraws also use
the idle gap after a burst, leaving at least 100 ms before the next slot.
`controller.lcd_transfer_progress` and `lcd_progress_updates` report the last
LCD progress value (-1 when asleep) and redraw count. The live check
`tools/test_controller_progress.py --serial YOUR_SERIAL --output artifacts/lcd-progress/test.json`
resends the currently selected image and verifies changing LCD progress and
the tag acknowledgement. USB diagnostics use an 8 KB transmit buffer and
a bounded transmit timeout so a missing serial reader cannot hold up protocol
timing. A serial monitor is not required for normal use.
LCD uses Adafruit ST7789/GFX with the radio's existing SPI driver instance. The radio retains the upstream
file-backed command path, and application queue/menu work waits for gaps between
transmission bursts. Packet recovery follows the upstream protocol, with an
explicit 1 ms minimum packet gap. HTTP callbacks are pinned to core 0, separate
from the Arduino radio loop on core 1; radio mode notifications never wait on
the model mutex.
Packet dumps are disabled by default; `CHROMA_RADIO_TRACE` enables diagnostic
tracing when a USB serial reader is attached.
Queue bookkeeping is rate limited and takes the shared model mutex without
waiting; wheel input is sampled at 100 Hz. Radio events take priority over
application processing during transmission bursts.

The bench-only `POST /api/v1/diagnostics` endpoint accepts `backlight`, `encoder`,
and `redraw` booleans, plus `inspect: true` to capture radio registers and GPIO
levels in the next state response. `direct: false` selects an isolated radio
service for diagnosis: it preserves the queue, restarts without initializing
the LCD, transmits, and returns to the menu. This fallback briefly interrupts
HTTP connectivity; the CLI's `--wait` handles reconnects. Normal direct sends
keep the same server session. Diagnostic settings reset at boot.

The API currently has no authentication and is intended for a trusted home LAN.
Do not expose the controller through port forwarding.

## Development and deployment

```powershell
cd ui
npm ci
npm run build
npm test
node tests/browser.mjs
node scripts/build.mjs --deploy
```

The browser test uses Playwright Chromium (run `npx playwright install chromium`) and mocked controller responses. Set `CHROMA_BROWSER_PATH` to use an existing browser executable.
`node tests/hardware.mjs` is an explicit live test: it rewrites the Hello Studio
sample, preserves the rest of the library, sends it to the display specified by `CHROMA_SERIAL`, and waits
for acknowledgement. `node tests/preview.mjs` performs a read-only check against
the acknowledged text snapshots created on this computer in `backups/studio-final`.
`npm run dev` serves localhost:5173 with an API proxy to `CHROMA_CONTROLLER`
(default `http://chroma.local`). Production assets are self-contained, compressed,
and copied into `firmware/data` by `--deploy`.

Build firmware and filesystem sequentially using the board setup instructions.
Keep the firmware binary before building the filesystem, as PlatformIO may clean
the shared output directory. Flashing a filesystem image replaces saved screens
and registry: download metadata **and every referenced asset** first. Application
updates alone preserve SPIFFS and NVS Wi-Fi settings. The original full-device
backup remains in `backups/`; pre-Studio controller files are in
`backups/pre-studio/` and the previous application artifacts in
`artifacts/pre-studio-firmware/`.

To preserve a library while deploying new web assets, run `backup_studio.py`,
then `stage_library.py <backup-directory>` before building the filesystem.
After copying the built filesystem image to your release directory, run
`stage_library.py <backup-directory> --clean`. The cleanup checks hashes and
removes only the matching temporary files in `firmware/data`. The final
workspace library is backed up in `backups/studio-final/`.
