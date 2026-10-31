"""Capture a bounded USB serial log; optionally restart the application."""
import argparse
from pathlib import Path
import re
import time

import serial
from esptool.reset import HardReset

parser = argparse.ArgumentParser()
parser.add_argument("--port", default="COM12")
parser.add_argument("--seconds", type=float, default=15)
parser.add_argument("--reset", action="store_true")
parser.add_argument("--output", default="serial-boot.log")
args = parser.parse_args()

port = serial.Serial(port=None, baudrate=500000, timeout=0.25)
port.dtr = False
port.rts = False
port.port = args.port
with port:
    if args.reset:
        HardReset(port, uses_usb=True)()
    chunks = []
    deadline = time.monotonic() + args.seconds
    while time.monotonic() < deadline:
        chunk = port.read(max(1, port.in_waiting))
        if chunk:
            chunks.append(chunk)

log = b"".join(chunks).decode("utf-8", errors="replace")
log = re.sub(r"(?im)^.*(?:password|\bpsk\b).*$", "[Wi-Fi credential log redacted]", log)
Path(args.output).write_text(log, encoding="utf-8")
print(log[-12000:])
