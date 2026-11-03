# Radio tools, image history and MQTT

Studio 0.4 adds these features to the existing controller and companion. Update
both the application and filesystem, preserving your library as described in the
main setup instructions. Run `npm ci` in `ui/` before restarting the companion.

## Radio measurements

Select a display in **Diagnostics**. Radio reliability records completed jobs,
acknowledged jobs, failed/cancelled jobs, total attempts, extra attempts and radio
duration. These counters begin with this update and persist across restarts.
They combine image sends and read-only diagnostic reads. The acknowledgement
percentage is acknowledged jobs divided by attempted terminal jobs; it is not
RSSI, link quality, or proof that the physical panel refreshed.

Radio duration includes active transfer attempts and excludes queue time, wake
synchronization and retry waits. Interrupted attempts may have incomplete timing.
Counters are operational diagnostics rather than an exact billing/audit log.

**Run connection test** queues three read-only panel queries on the display's
registered channel. Compare results with the controller nearby and at its normal
location. Download a radio report to retain the readings. Cancel pending reads in
Activity. This is not a frequency sweep: changing the controller channel alone
would lose contact with a tag configured on another channel.

## Image history

**History** retains the newest 16 acknowledged image snapshots globally, with
thumbnails, target, timestamp, attempts and radio duration. Storage pressure can
evict older history sooner to preserve space for saved-screen metadata. Queued
and failed images are shown in Activity instead. History starts with new sends;
the old job journal cannot reconstruct image files already edited or deleted.

**Resend this image** sends its original binary snapshot, even if its saved
template was edited or removed. It creates a new job and requires a new visual
confirmation. The last transmitted image for each registered display remains
pinned even if its history entry is removed. Files become eligible for cleanup
after they have no saved-screen, history, current-display or pending-job reference.

Visual confirmation belongs to the specific most recent image, not all versions
of its template. Diagnostics records **Looks correct** / **Still blank** against
that image ID. Acknowledgement remains distinct from looking at the physical glass.

Full browser and CLI backups include historical and current image dependencies.
Restoring a browser backup appends its history with new IDs and clears historical
visual confirmations. It does not claim those images are currently on the tags,
or replace their radio counters. Existing unrelated entries remain, subject to
the 16-entry limit. A current image absent from backed-up history is restored as
a history entry so it can be resent. CLI filesystem staging preserves the complete model.

## Home Assistant and MQTT

An existing MQTT broker is required. The companion computer must remain running.
Start it as documented in [features.md](features.md), then use **Settings →
Connect with MQTT** to enter the broker URL, username/password, topic prefix and
client ID. Enable MQTT and discovery. Each controller/companion instance needs a
unique client ID **and** topic prefix. The default prefix is `chroma-studio`.

Use `mqtt://host:1883` or `mqtts://host:8883` with a trusted TLS certificate.
Credentials are stored only in the ignored companion config, not returned by
status APIs or included in controller backups. A blank password keeps the saved
one; use **Clear saved password** to remove it. Username is required with a password.

Home Assistant discovery creates a controller radio-state sensor and, for each
display, a transfer-status sensor, acknowledgement-rate sensor and saved-screen
selector. Selector options are stable preset IDs; the settings page lists IDs
beside names. Status updates every five seconds. Discovery is republished after
reconnect and Home Assistant's `homeassistant/status` birth message. Removed
display entities and disabled discovery are cleared while connected to the broker.
Home Assistant must already have its MQTT integration connected to the same broker.
See the official [MQTT discovery documentation](https://www.home-assistant.io/integrations/mqtt/#mqtt-discovery).
The companion uses [MQTT.js](https://github.com/mqttjs/MQTT.js).

Publish JSON to `<prefix>/command` with **retain off**:

```json
{
  "request_id": "kitchen-status-001",
  "serial": "JM00000000B",
  "preset": "YOUR_PRESET_ID",
  "variables": { "status": "Online", "temperature": 21 }
}
```

Omit `variables` to send the saved binary as-is. With variables, the companion
renders a text/layout template into a separate snapshot without editing the
saved template. Missing variables or overflowing content reject the command.
Use up to 20 primitive variables. Commands are limited to 4 KB and cannot alter
tag firmware, pairing or radio settings. Commands for already-busy tags are rejected.

Use a unique `request_id` for each intended send. The last 64 accepted IDs survive
companion restart; repeating one returns its previous job ID. There is still a
small crash window between controller acceptance and saving the deduplication
record. This is not an exactly-once delivery guarantee. Retained commands received
on subscription are rejected. Clear old retained commands in your broker. Home
Assistant selector commands use non-retained QoS 0 payloads of the preset ID on
`<prefix>/display/<serial>/send`; explicit IDs are available through the JSON API.

Topics:

| Topic under prefix | Contents |
| --- | --- |
| `availability` | Companion online/offline; broker last will handles disconnect |
| `controller/availability` | Controller HTTP reachability |
| `controller/state` | Firmware, IP and radio mode |
| `display/<serial>/state` | Job progress/result, retries, last preset/image and visual confirmation |
| `result` | Non-retained immediate command acceptance/rejection and duplicate result |

`queued` only means accepted. Observe the display state topic for later
`completed`, `failed` or `cancelled`. A completed transfer means acknowledged.
Restrict MQTT credentials to the needed topics on your trusted LAN.

## API additions

Controller endpoints under `/api/v1`:

| Method / path | Body or result |
| --- | --- |
| `GET /history` | Retained image snapshots |
| `POST /history/resend` | `id` of a history entry |
| `POST /history/clear` | Optional `id`; omitted clears retained history |
| `POST /history/import` | One validated backup entry with existing asset and registered target |
| `POST /jobs/frame` | `serial`, uploaded `asset`, optional `title`; sends a snapshot |
| `POST /displays/confirm` | `serial`, `image_id`, boolean `confirmed` |

`GET /state` includes `history`, per-device `radio_stats`, `last_asset` and
`last_image_id`. The companion exposes `GET/POST /live/mqtt`; its GET response
never includes the saved password. Other APIs remain compatible.

## Verification

From `ui/`: `npm test`, `node tests/features-browser.mjs`,
`node tests/reliability-browser.mjs`, `node tests/companion.mjs`, and
`node tests/mqtt.mjs`. The MQTT test runs an isolated local broker and verifies
discovery, command execution, retained-message rejection, deduplication,
template snapshots, availability and credential handling. No home broker is
required for these tests.

The live hardware check sends a selected saved screen twice, temporarily changes
its template's asset reference, verifies snapshot retention through cleanup, then
restores the original template and runs a read-only panel probe:

```powershell
.venv/Scripts/python.exe tools/test_radio_history.py --controller http://<controller-ip> --serial YOUR_SERIAL --preset FINAL_PRESET_ID --alternate-preset OTHER_PRESET_ID --output artifacts/radio-history-test.json
```
