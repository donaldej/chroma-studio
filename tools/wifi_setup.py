"""Configure Chroma74 home Wi-Fi locally over USB; never log credentials."""
import json
from datetime import datetime, timezone
from pathlib import Path
import queue
import threading
import time
import tkinter as tk
from tkinter import messagebox, ttk
import webbrowser

import serial
from serial.tools import list_ports


def serial_worker(port_name, commands, events, stop):
    port = serial.Serial(port=None, baudrate=500000, timeout=0.2, write_timeout=2)
    port.dtr = False
    port.rts = False
    port.port = port_name
    try:
        with port:
            last_status = 0
            buffer = bytearray()
            while not stop.is_set():
                try:
                    command = commands.get_nowait()
                    port.write((json.dumps(command, ensure_ascii=True) + "\n").encode())
                except queue.Empty:
                    pass
                if time.monotonic() - last_status > 3:
                    port.write(b'{"op":"wifi.status"}\n')
                    last_status = time.monotonic()
                buffer.extend(port.read(max(1, min(port.in_waiting, 4096))))
                while b"\n" in buffer:
                    raw, _, buffer = buffer.partition(b"\n")
                    try:
                        event = json.loads(raw.decode("utf-8").strip())
                        if isinstance(event, dict) and str(event.get("event", "")).startswith("wifi."):
                            events.put(event)
                    except (ValueError, UnicodeError):
                        pass  # Ignore radio diagnostics and boot messages.
                if len(buffer) > 8192:
                    buffer.clear()
    except (serial.SerialException, OSError):
        events.put({"event": "usb.error", "error": "Cannot access the device. Check the port and close other serial monitors."})


class SetupWindow:
    def __init__(self, root):
        self.root = root
        root.title("Chroma74 — Home Wi-Fi setup")
        root.resizable(False, False)
        self.commands = queue.Queue()
        self.events = queue.Queue()
        self.stop = threading.Event()
        self.worker = None
        self.url = None
        self.connecting = False
        self.status_path = Path(__file__).resolve().parents[1] / "artifacts" / "wifi-setup-status.json"
        self.status_path.parent.mkdir(exist_ok=True)
        self.save_status({"event": "usb.opening"})
        ports = list(list_ports.comports())
        preferred = next((p.device for p in ports if p.vid == 0x303A), "COM12")
        self.port = tk.StringVar(value=preferred)
        self.ssid = tk.StringVar()
        self.password = tk.StringVar()
        self.status = tk.StringVar(value="Enter your 2.4 GHz home Wi-Fi settings.")
        frame = ttk.Frame(root, padding=22)
        frame.grid()
        ttk.Label(frame, text="Connect your Chroma74 controller", font=("Segoe UI", 14, "bold")).grid(row=0, columnspan=2, sticky="w")
        ttk.Label(frame, text="Settings go directly over USB. The password is not saved on this computer.").grid(row=1, columnspan=2, pady=(8, 18), sticky="w")
        for row, label in ((2, "USB port"), (3, "Wi-Fi network name"), (4, "Wi-Fi password")):
            ttk.Label(frame, text=label).grid(row=row, column=0, padx=(0, 12), pady=7, sticky="w")
        self.port_picker = ttk.Combobox(frame, textvariable=self.port, values=[p.device for p in ports], width=33)
        self.port_picker.grid(row=2, column=1, sticky="ew")
        ttk.Entry(frame, textvariable=self.ssid, width=36).grid(row=3, column=1, sticky="ew")
        ttk.Entry(frame, textvariable=self.password, show="•", width=36).grid(row=4, column=1, sticky="ew")
        self.connect_button = ttk.Button(frame, text="Connect to home Wi-Fi", command=self.configure)
        self.connect_button.grid(row=5, columnspan=2, pady=16)
        ttk.Label(frame, textvariable=self.status, wraplength=510).grid(row=6, columnspan=2, sticky="w")
        self.open_button = ttk.Button(frame, text="Open display controls", command=lambda: webbrowser.open(self.url), state="disabled")
        self.open_button.grid(row=7, columnspan=2, pady=(14, 0))
        root.protocol("WM_DELETE_WINDOW", self.close)
        root.after(150, self.poll_events)
        root.after(200, self.start_worker)

    def start_worker(self):
        if self.worker and self.worker.is_alive():
            return
        self.stop = threading.Event()
        self.worker = threading.Thread(target=serial_worker, args=(self.port.get(), self.commands, self.events, self.stop), daemon=True)
        self.worker.start()
        self.port_picker.configure(state="disabled")

    def configure(self):
        ssid, password = self.ssid.get(), self.password.get()
        valid_password = not password or 8 <= len(password.encode()) <= 63 or (len(password) == 64 and all(c in "0123456789abcdefABCDEF" for c in password))
        if not 1 <= len(ssid.encode()) <= 32 or not valid_password:
            messagebox.showerror("Check Wi-Fi settings", "Enter a network name (up to 32 bytes) and an 8–63 byte password. Leave the password empty only for an open network.")
            return
        self.start_worker()
        self.commands.put({"op": "wifi.configure", "ssid": ssid, "password": password})
        self.password.set("")
        self.connecting = True
        self.url = None
        self.open_button.configure(state="disabled")
        self.status.set("Connecting… This can take up to 25 seconds.")
        self.connect_button.configure(state="disabled")

    def poll_events(self):
        while not self.events.empty():
            event = self.events.get_nowait()
            self.save_status(event)
            kind = event.get("event")
            if kind == "wifi.connected" or (kind == "wifi.status" and event.get("connected") and not self.connecting):
                self.url = "http://" + event["ip"] + "/"
                self.status.set("Connected to home Wi-Fi. Display controls: " + self.url)
                self.open_button.configure(state="normal")
                self.connect_button.configure(state="normal")
                self.connecting = False
            elif kind in ("wifi.failed", "wifi.error", "usb.error"):
                self.status.set(event.get("error", "Connection failed. Please try again."))
                self.connect_button.configure(state="normal")
                self.connecting = False
                if kind == "usb.error":
                    self.port_picker.configure(state="normal")
            elif kind == "wifi.disconnected":
                self.status.set("Home Wi-Fi disconnected. The controller will try to reconnect.")
                self.open_button.configure(state="disabled")
        self.root.after(150, self.poll_events)

    def save_status(self, event):
        # Keep only connection status so diagnostics can run without opening USB twice.
        status = {key: event[key] for key in ("event", "connected", "ip", "setup_ip") if key in event}
        status["updated_utc"] = datetime.now(timezone.utc).isoformat()
        self.status_path.write_text(json.dumps(status), encoding="utf-8")

    def close(self):
        self.stop.set()
        self.password.set("")
        self.root.destroy()


if __name__ == "__main__":
    root = tk.Tk()
    SetupWindow(root)
    root.mainloop()
