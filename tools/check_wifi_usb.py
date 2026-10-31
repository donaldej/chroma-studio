"""Exercise the live USB Wi-Fi protocol without changing saved credentials."""
import argparse
import json
import time
import serial

parser = argparse.ArgumentParser()
parser.add_argument("--port", default="COM12")
args = parser.parse_args()


def exchange(port, payload, expected):
    port.reset_input_buffer()
    port.write(payload + b"\n")
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        try:
            event = json.loads(port.readline().decode("utf-8").strip())
        except (ValueError, UnicodeError):
            continue
        if isinstance(event, dict) and event.get("event") == expected:
            return event
    raise RuntimeError("Missing response: " + expected)


port = serial.Serial(port=None, baudrate=500000, timeout=0.2, write_timeout=2)
port.dtr = False
port.rts = False
port.port = args.port
with port:
    status = exchange(port, b'{"op":"wifi.status"}', "wifi.status")
    assert "connected" in status and "ip" in status
    exchange(port, b'{"op":"wifi.configure","ssid":"","password":""}', "wifi.error")
    exchange(port, b'{"op":"wifi.configure","ssid":"validation-only","password":"short"}', "wifi.error")
    exchange(port, b"{" * 1100, "wifi.error")
    exchange(port, b'{"op":"wifi.status"}', "wifi.status")
print("PASS: live USB status, invalid settings rejection, and oversized-command recovery")
