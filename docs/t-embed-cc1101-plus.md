# T-Embed CC1101 Plus

The tested target is the ESP32-S3 board with 16 MB flash and 8 MB OPI PSRAM.
Follow the [README](../README.md) for first-time installation and Wi-Fi setup.

## Hardware mapping

Mappings follow [LILYGO's reference](https://github.com/Xinyuan-LilyGO/T-Embed-CC1101),
revision `c36826e0f91311cb591c4545fccf91e254fc55dc`.

| Signal | GPIO |
| --- | --- |
| Shared SPI SCK / MOSI / MISO | 11 / 9 / 10 |
| CC1101 CS / GDO2 / GDO0 | 12 / 38 / 3 |
| Peripheral enable | 15, high |
| RF switch SW1 / SW0 | 47 low / 48 high |
| LCD CS / DC / backlight | 41 / 16 / 21 |
| Encoder A / B / press | 4 / 5 / 0 |
| Side/home/wake button | 6 |

The RF switch selects the 868/915 MHz antenna path. Actual frequencies are selected
by the protocol's channel table. Wake-up controls include EU channel 4 and US
channel 35; match your display and region. The original upstream hardware uses an
868 MHz CC1101 module and warns against substituting a 433 MHz module.

SD CS13 and nRF24 CS44 remain high, and nRF24 CE43 remains low. The LCD and radio
share the same SPI driver. LCD progress redraws happen only in idle gaps between
radio bursts; full menu redraws use the middle of an idle slot. HTTP callbacks
run on core 0, separate from the Arduino/radio loop on core 1.

## Build and flash layout

The environment pins Espressif32 6.13.0 / Arduino-ESP32 2.0.17 and its library
versions. Use `t-embed-cc1101-plus` in `firmware/platformio.ini`.

| Image | Offset |
| --- | --- |
| `bootloader.bin` | `0x0` |
| `partitions.bin` | `0x8000` |
| `boot_app0.bin` | `0xe000` |
| `firmware.bin` | `0x10000` |
| `spiffs.bin` | `0xc90000` |

Prefer PlatformIO upload targets in the README; they set the required flash
parameters. Build and buildfs targets share an output directory: run sequentially
and copy an application binary elsewhere before building a filesystem if you
need to retain both images. `uploadfs` replaces the library and registry unless
you stage a downloaded backup first.

## Wi-Fi and USB

Use a 2.4 GHz home network. The GUI sends newline-delimited `wifi.status` and
`wifi.configure` JSON commands over USB at 500000 baud. Successful credentials
are stored in NVS; failed attempts preserve the previous saved credentials.
Replies do not echo passwords. Close serial monitors before starting the GUI.

When disconnected, the controller offers `Chroma74-Setup` at
`http://192.168.4.1/wifi`. The AP shuts down after a successful home-network
connection and returns after a prolonged disconnection. The LCD's **Connection**
page shows the home IP. `/wifi/status` reports connection state.

## Backup and rollback

Back up before the first flash. Replace `COM12`, choose a fresh filename, and
create `backups/` first. For an unencrypted 16 MB board:

```powershell
.venv/Scripts/python.exe -m esptool --chip esp32s3 --port COM12 --baud 460800 --after no_reset read_flash 0x0 0x1000000 backups/original-full.bin
.venv/Scripts/python.exe -m esptool --chip esp32s3 --port COM12 --before no_reset verify_flash 0x0 backups/original-full.bin
Get-FileHash backups/original-full.bin -Algorithm SHA256
```

Check the file is 16,777,216 bytes and the digest matches. The read/verification
pauses the application; reset resumes it. Store backups privately: they can
contain NVS Wi-Fi credentials. They are not distributed in this repository.

Restore only the verified backup for that same board, with the same security
configuration. This command replaces the entire flash, including Studio and its
current library/settings:

```powershell
.venv/Scripts/python.exe -m esptool --chip esp32s3 --port COM12 --baud 460800 write_flash 0x0 backups/original-full.bin
```

A flash backup does not include or restore eFuses. This project does not burn
eFuses. Do not apply this plain-flash workflow unchanged to a board using secure
boot or flash encryption. Check the port after resets/bootloader entry.

Library-only backups use `tools/backup_studio.py`; metadata export alone omits
image assets. See the README for staging a backup during a frontend update.

## Validation

The tested board's CC1101 reports version `0x14` and passes the GDO2 check.
Physical black/yellow full-frame transfers have been acknowledged with the
browser online, no controller restart, and changing LCD progress through 100%.
The firmware uses about 130 KB static RAM and 1.19 MB application flash.
Private device-specific manifests/backups are kept locally under ignored
`artifacts/` and `backups/`; a fresh clone does not include them.
