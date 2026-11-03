# Studio 0.3 features

## Diagnostics and visual confirmation

Open **Diagnostics**, select a display, and run individual reads or **Run all
checks**. Reads share the transfer queue; they do not alter the tag image.
The page shows reported voltage, panel resolution, firmware, raw update counters,
and the last reply. Voltage is not a battery percentage or a load test.
Internal IDs are raw tag identifiers and may differ from the printed radio serial.

**Acknowledged** means transport completed. After examining the physical screen,
choose **Looks correct** or **Still blank / incorrect**. Each new image clears
the previous visual confirmation. Increasing update counters do not prove that
the panel physically refreshed. Diagnostic reports can be downloaded as JSON.

## Recovery and retry limits

**Settings → Controller & recovery** sets a maximum of one, two, or three total
attempts. The default is two. Transport timeouts retry after a bounded delay;
pairing, missing files, and invalid configuration do not retry automatically.
**Activity** shows retry status, attempt limits, and cancellation controls.

The last 12 jobs are journaled in SPIFFS. Queued transfers survive reboot;
interrupted sends resume only while their attempt budget remains. This is
at-least-once recovery: an image may be sent again if power fails after the tag
accepted it but before completion was stored. Cancellation persists too.
The journal uses a temporary file and backup generation for interrupted writes.
It excludes Wi-Fi credentials.

## Schedules and playlists

Open **Automations** and create a one-time send, daily schedule, repeating
interval, or playlist. Pick a target display and saved screens. Playlists can
hold 10 ordered entries; the controller supports 12 automations in total.
Intervals range from five minutes to seven days.

Set the controller timezone under **Settings**. Supported zones are UTC,
New York, Chicago, Denver, Los Angeles, London, Berlin, and Sydney. Daily sends
use the configured timezone and its daylight-saving rules. One-time form values
use the browser's local timezone and are stored as Unix timestamps.

The controller gets time from NTP. If internet time is unavailable, **Sync time
now** uses the browser clock. Automations wait until the clock is valid. They
run with the browser closed. A busy display delays its automation rather than
creating an unbounded queue; missed interval occurrences are not replayed in bulk.

Playlists wait for an acknowledged transfer before starting the next interval.
A playlist pauses after terminal failure or cancellation. It can be enabled or
paused in the browser or the controller's **Playlists** wheel menu. Pausing
does not interrupt a transfer already accepted; use Activity to cancel it.
Removing referenced screens or displays requires removing their automations first.

## Layout editor and templates

Choose **Layout** in the editor or start with **Use a template**. Add up to six
text, rectangle, QR, and image layers. Drag layers on the preview or edit exact
X/Y/width/height values. Text supports fonts and sizes; layers can be reordered
with **Bring to front**. QR codes include a quiet zone and render in black/white.
The editor rejects content that overflows rather than silently clipping it.

Layer outlines are editing guides only. Uploaded images become pigment-quantized
assets; layer image dependencies remain in the library backup even if they are
not separately saved as screens. Keep combined layer text within 600 characters;
the controller also enforces its metadata and request-size limits.

Starter templates include weather, server status, a calendar notice, clock/date,
and a QR notice. A live template uses variables such as `{{temperature}}`,
`{{status}}`, `{{event}}`, `{{when}}`, `{{time}}`, and `{{date}}`.
The editor shows the variable placeholders until the companion renders real data.
Calendar notices use a JSON source, such as a Home Assistant calendar entity;
this release does not sign in to calendar accounts or parse recurring ICS feeds.

## Live data companion

External requests and template rendering run on an optional computer/home server,
not on the radio controller. Install the UI dependencies and build first:

```powershell
cd ui
npm ci
npm run build
npx playwright install chromium
cd ..
node tools/live-data.mjs --controller http://<controller-ip> --host 0.0.0.0
```

The default bind address is loopback if `--host` is omitted. Binding to
`0.0.0.0` allows access from your LAN. Windows can use an installed Edge browser;
`CHROMA_BROWSER_PATH` selects another Chromium-compatible executable. A server
may need Playwright's normal Linux system dependencies.

Set **Settings → Live data server address** to `http://<server-ip>:8787`, then
open **Live data**. The companion also serves Studio itself at that address,
proxying controller API calls. Use `--port`, `--config`, and `--allow-origin` for
a nondefault port, private config location, or custom browser origin.

Sources support:

- **Clock & date:** local formatting in an IANA timezone.
- **Weather:** coordinates and Celsius/Fahrenheit using the
  [Open-Meteo current-weather API](https://open-meteo.com/en/docs).
  Variables include `temperature`, `condition`, `humidity`, `wind`, and `unit`.
- **JSON / Home Assistant / server status:** an HTTP(S) endpoint, optional
  Authorization header, and variable mappings such as `status=state`,
  `temperature=attributes.temperature`, or `cpu=servers.0.cpu`.
  Calendar examples are `event=attributes.message` and
  `when=attributes.start_time`.

Sources are created paused by default. Enable one or choose **Update now**.
The companion renders the saved design with mapped values, uploads a new packet,
and waits for acknowledgement before recording the image hash. Identical frames
are skipped; errors retain the last image. It waits when the target already has
a pending transfer. Refresh intervals have a five-minute minimum.

The host must stay on for live sources; controller-only schedules do not depend
on it. Runtime and source credentials are stored under
`artifacts/live-data/config.json` by default, excluded from Git. Authorization
values are not returned by the status API or included in controller backups.
Back up that private companion configuration separately. Use a trusted LAN;
neither service is intended for internet exposure. Browser origins are restricted
to the controller and this host; custom origins require explicit configuration.

## Full library backup and restore

**Settings → Download full backup** creates one JSON file with registry, settings,
automations, screen metadata, all frame/image dependencies, and SHA-256 hashes.
**Restore backup** validates hashes before writing, downloads a backup of the
current library first, and merges entries. Matching IDs are updated; unrelated
entries remain. Restored automations are paused. Wi-Fi credentials and companion
source credentials are not restored.

Finish/cancel pending transfers before restoring. A network failure can leave a
partially merged restore; retrying with the original backup is supported. No
existing unrelated assets are explicitly erased. Available storage and controller
limits still apply. Metadata export alone is not a complete image backup.

CLI backups now also include recent job history. Filesystem staging preserves
that history but refuses snapshots containing pending jobs; finish/cancel those
jobs and take a fresh backup before `uploadfs`. Application-only updates preserve
the job journal and library in place.

## Controller controls

Brightness and an optional 30-second to 10-minute screen timeout are configurable
in Settings; **Never** disables the timeout. Automatic sleep wakes for a transfer
and shows live progress. A deliberate **Power → Turn off screen** stays dark
during transfers. Press a button or turn the wheel to wake the LCD. The waking
gesture is consumed rather than selecting a menu item. The API also accepts
timeout values up to one hour.

Short side press returns home; holding it opens the display list. Playlists can
be toggled from the wheel menu. Transfer results distinguish acknowledgement from
physical confirmation. Shutdown uses deep sleep; the side button wakes it.

## Additional API endpoints

| POST path under `/api/v1` | Body |
| --- | --- |
| `/settings` | `brightness`, `screen_timeout`, `max_attempts`, `timezone`, `companion_url` |
| `/time` | `epoch` Unix seconds |
| `/automations` | `id`, `name`, `kind`, `serial`, `preset` or `presets`, timing fields, `enabled` |
| `/automations/toggle` | `id`, `enabled` |
| `/automations/delete` | `id` |
| `/displays/confirm` | `serial`, current `preset`, boolean `confirmed` |
| `/jobs/clear` | Optional `id`; removes terminal jobs only |

`GET /state` includes settings, automations, clock status, health metadata,
attempt counts, retry delays, source automation IDs, and snapshot asset IDs.
Mutations return 202: poll until the requested state has been applied.

## Checks

From `ui/`, run `npm test`, `node tests/browser.mjs`, and
`node tests/features-browser.mjs`. The feature browser test checks drag coordinates,
decodes a generated QR, verifies image dependencies, edits a playlist, records
visual confirmation, and round-trips a complete checksummed backup. Live controller
checks and companion integration tests are documented in their test files.
