#ifdef CHROMA_T_EMBED_CC1101
#include <Arduino.h>
#include <ArduinoJson.h>
#include <ESPAsyncWebServer.h>
#include <Preferences.h>
#include <WiFi.h>
#include "network_setup.h"

namespace {
struct Credentials { char ssid[33]; char password[65]; };
QueueHandle_t pending_credentials;
Credentials connecting = {};
bool attempting = false;
bool save_on_connect = false;
bool reported_connected = false;
bool setup_ap_running = false;
uint32_t attempt_started;
uint32_t disconnected_since;
char input[1024];
size_t input_length = 0;
bool discard_line = false;

const char setup_page[] PROGMEM = R"HTML(<!doctype html>
<html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Chroma74 Wi-Fi</title></head><body>
<h1>Connect to home Wi-Fi</h1><p>Use a 2.4 GHz network.</p>
<form id="setup"><p><label>Network name <input name="ssid" maxlength="32" required></label></p>
<p><label>Password <input name="password" type="password" maxlength="64" autocomplete="new-password"></label></p>
<button>Connect</button></form><p id="result"></p><a href="/">Display controls</a>
<script>const result=document.getElementById('result');
document.getElementById('setup').onsubmit=async e=>{e.preventDefault();
try {const r=await fetch('/wifi',{method:'POST',body:new URLSearchParams(new FormData(e.target))});
const d=await r.json();result.textContent=r.ok?'Connecting. Once connected, use the home network IP shown over USB.':d.error;}
catch(e){result.textContent='Unable to send settings. Try the USB setup tool.';}};
</script></body></html>)HTML";

String status_json(const char *event) {
  StaticJsonDocument<256> doc;
  doc["event"] = event;
  doc["connected"] = WiFi.status() == WL_CONNECTED;
  doc["ip"] = WiFi.status() == WL_CONNECTED ? WiFi.localIP().toString() : "";
  doc["setup_ip"] = setup_ap_running ? WiFi.softAPIP().toString() : "";
  String result;
  serializeJson(doc, result);
  return result;
}

void start_setup_ap() {
  if (setup_ap_running) return;
  WiFi.mode(WIFI_AP_STA);
  setup_ap_running = WiFi.softAP("Chroma74-Setup");
  Serial.println(status_json("wifi.setup"));
}

bool enqueue_credentials(const String &ssid, const String &password) {
  if (ssid.length() < 1 || ssid.length() > 32 || password.length() > 64 ||
      (password.length() > 0 && password.length() < 8)) return false;
  if (password.length() == 64) {
    for (size_t i = 0; i < password.length(); ++i)
      if (!isxdigit(static_cast<unsigned char>(password[i]))) return false;
  }
  Credentials credentials = {};
  ssid.toCharArray(credentials.ssid, sizeof(credentials.ssid));
  password.toCharArray(credentials.password, sizeof(credentials.password));
  return xQueueOverwrite(pending_credentials, &credentials) == pdPASS;
}

void connect_network(const Credentials &credentials, bool save) {
  connecting = credentials;
  WiFi.disconnect(false, false);
  reported_connected = false;
  attempting = true;
  save_on_connect = save;
  attempt_started = millis();
  WiFi.begin(connecting.ssid, connecting.password);
  Serial.println("{\"event\":\"wifi.connecting\"}");
}

void process_line() {
  StaticJsonDocument<512> doc;
  if (deserializeJson(doc, input)) {
    Serial.println("{\"event\":\"wifi.error\",\"error\":\"Invalid JSON command\"}");
    return;
  }
  const char *operation = doc["op"] | "";
  if (strcmp(operation, "wifi.status") == 0) {
    Serial.println(status_json("wifi.status"));
  } else if (strcmp(operation, "wifi.configure") == 0 &&
             doc["ssid"].is<const char *>() && doc["password"].is<const char *>() &&
             enqueue_credentials(doc["ssid"].as<String>(), doc["password"].as<String>())) {
    Serial.println("{\"event\":\"wifi.accepted\"}");
  } else {
    Serial.println("{\"event\":\"wifi.error\",\"error\":\"Invalid Wi-Fi settings or command\"}");
  }
}
}

void init_network() {
  pending_credentials = xQueueCreate(1, sizeof(Credentials));
  if (!pending_credentials) {
    Serial.println("Unable to allocate Wi-Fi setup queue");
    return;
  }
  WiFi.persistent(false);
  WiFi.setAutoReconnect(true);
  start_setup_ap();
  disconnected_since = millis();
  Preferences preferences;
  Credentials saved = {};
  if (preferences.begin("chroma-wifi", false)) {
    if (preferences.getBytesLength("credentials") == sizeof(saved))
      preferences.getBytes("credentials", &saved, sizeof(saved));
    preferences.end();
  }
  if (saved.ssid[0]) connect_network(saved, false);
  Serial.println("USB Wi-Fi setup ready");
}

void poll_network() {
  if (!pending_credentials) return;
  // Limit serial work per pass so radio and HTTP processing remain responsive.
  for (size_t count = 0; count < 128 && Serial.available(); ++count) {
    const char value = Serial.read();
    if (value == '\n') {
      if (discard_line) {
        Serial.println("{\"event\":\"wifi.error\",\"error\":\"Command too long\"}");
      } else if (input_length) {
        input[input_length] = '\0';
        process_line();
      }
      memset(input, 0, sizeof(input));
      input_length = 0;
      discard_line = false;
    } else if (value != '\r' && !discard_line) {
      if (input_length < sizeof(input) - 1) input[input_length++] = value;
      else discard_line = true;
    }
  }
  Credentials requested;
  if (xQueueReceive(pending_credentials, &requested, 0) == pdPASS) {
    start_setup_ap();
    connect_network(requested, true);
    memset(&requested, 0, sizeof(requested));
  }
  if (WiFi.status() == WL_CONNECTED) {
    if (!reported_connected) {
      bool saved_ok = true;
      if (save_on_connect) {
        Preferences preferences;
        saved_ok = preferences.begin("chroma-wifi", false);
        if (saved_ok) {
          saved_ok = preferences.putBytes("credentials", &connecting, sizeof(connecting)) == sizeof(connecting);
          preferences.end();
        }
      }
      save_on_connect = false;
      attempting = false;
      reported_connected = true;
      memset(&connecting, 0, sizeof(connecting));
      if (setup_ap_running) {
        WiFi.softAPdisconnect(true);
        WiFi.mode(WIFI_STA);
        setup_ap_running = false;
      }
      Serial.println(status_json("wifi.connected"));
      if (!saved_ok) Serial.println("{\"event\":\"wifi.error\",\"error\":\"Connected but could not save settings\"}");
    }
    disconnected_since = millis();
  } else {
    if (reported_connected) {
      reported_connected = false;
      Serial.println(status_json("wifi.disconnected"));
    }
    if (attempting && millis() - attempt_started >= 25000) {
      attempting = false;
      const bool new_settings = save_on_connect;
      save_on_connect = false;
      // Keep retrying previously saved settings when the router is unavailable.
      if (new_settings) WiFi.disconnect(false, false);
      memset(&connecting, 0, sizeof(connecting));
      Serial.println("{\"event\":\"wifi.failed\",\"error\":\"Connection timed out; check the network name, password, and 2.4 GHz coverage\"}");
    }
    if (millis() - disconnected_since >= 30000) start_setup_ap();
  }
}

void register_network_routes(AsyncWebServer &server) {
  server.on("/wifi/status", HTTP_GET, [](AsyncWebServerRequest *request) {
    request->send(200, "application/json", status_json("wifi.status"));
  });
  server.on("/wifi", HTTP_GET, [](AsyncWebServerRequest *request) {
    request->send_P(200, "text/html", setup_page);
  });
  server.on("/wifi", HTTP_POST, [](AsyncWebServerRequest *request) {
    if (pending_credentials && request->hasParam("ssid", true) && request->hasParam("password", true) &&
        enqueue_credentials(request->getParam("ssid", true)->value(), request->getParam("password", true)->value())) {
      request->send(202, "application/json", "{\"event\":\"wifi.accepted\"}");
    } else {
      request->send(400, "application/json", "{\"error\":\"Check the network name and password length\"}");
    }
  });
}
#endif
