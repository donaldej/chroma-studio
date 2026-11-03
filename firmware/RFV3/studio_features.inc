// Included inside studio.cpp's private namespace; the main radio loop owns all
// scheduling and persistence. HTTP handlers only validate and enqueue actions.
const char *timezone_rule(const String &zone) {
  if (zone == "America/New_York") return "EST5EDT,M3.2.0/2,M11.1.0/2";
  if (zone == "America/Chicago") return "CST6CDT,M3.2.0/2,M11.1.0/2";
  if (zone == "America/Denver") return "MST7MDT,M3.2.0/2,M11.1.0/2";
  if (zone == "America/Los_Angeles") return "PST8PDT,M3.2.0/2,M11.1.0/2";
  if (zone == "Europe/London") return "GMT0BST,M3.5.0/1,M10.5.0/2";
  if (zone == "Europe/Berlin") return "CET-1CEST,M3.5.0/2,M10.5.0/3";
  if (zone == "Australia/Sydney") return "AEST-10AEDT,M10.1.0/2,M4.1.0/3";
  return "UTC0";
}
bool valid_timezone(const String &zone) {
  return zone == "UTC" || strcmp(timezone_rule(zone), "UTC0") != 0;
}
void apply_timezone() {
  setenv("TZ", timezone_rule(model["settings"]["timezone"] | String("UTC")), 1); tzset();
}
uint32_t next_daily(int hour, int minute, uint32_t after) {
  time_t instant = after; tm local; localtime_r(&instant, &local);
  local.tm_hour = hour; local.tm_min = minute; local.tm_sec = 0; local.tm_isdst = -1;
  time_t next = mktime(&local);
  if (next <= instant) { ++local.tm_mday; local.tm_hour = hour; local.tm_min = minute; local.tm_isdst = -1; next = mktime(&local); }
  return static_cast<uint32_t>(next);
}
void init_features() {
  if (!model["history"].is<JsonArray>()) model.createNestedArray("history");
  if (!model["automations"].is<JsonArray>()) model.createNestedArray("automations");
  if (!model["settings"].is<JsonObject>()) model.createNestedObject("settings");
  JsonObject settings = model["settings"];
  if (!settings.containsKey("timezone")) settings["timezone"] = "UTC";
  if (!settings.containsKey("brightness")) settings["brightness"] = 180;
  if (!settings.containsKey("screen_timeout")) settings["screen_timeout"] = 120;
  if (!settings.containsKey("max_attempts")) settings["max_attempts"] = 2;
  apply_timezone();
}
void record_transfer(const Job &job, const char *state) {
  if (!job.attempts || strcmp(job.kind, "activate") == 0) return;
  JsonObject device = find_item("devices", "serial", job.serial); if (device.isNull()) return;
  JsonObject stats = device["radio_stats"]; if (stats.isNull()) stats = device.createNestedObject("radio_stats");
  stats["jobs"] = (stats["jobs"] | 0U) + 1;
  stats["attempts"] = (stats["attempts"] | 0U) + job.attempts;
  stats["retries"] = (stats["retries"] | 0U) + job.attempts - 1;
  const char *key = strcmp(state, "completed") == 0 ? "acknowledged" : strcmp(state, "cancelled") == 0 ? "cancelled" : "failed";
  stats[key] = (stats[key] | 0U) + 1;
  stats["duration_ms"] = (stats["duration_ms"] | 0ULL) + job.elapsed_ms;
  stats["last_duration_ms"] = job.elapsed_ms; stats["last_result"] = String(state);
  stats["last_at"] = static_cast<uint32_t>(time(nullptr)); stats["channel"] = device["channel"].as<int>();
  stats["last_error"] = String(job.error);
  mark_dirty();
  if (strcmp(job.kind, "send") != 0 || strcmp(state, "completed") != 0) return;
  JsonArray history = model["history"];
  if (history.size() >= 16) history.remove(0);
  // Keep measurement overhead bounded as libraries approach the metadata limit.
  model.garbageCollect();
  while (model.capacity() - model.memoryUsage() < 1800 && model["history"].size()) { model["history"].as<JsonArray>().remove(0); model.garbageCollect(); }
  if (model.capacity() - model.memoryUsage() < 1800) return;
  JsonObject entry = model["history"].createNestedObject();
  entry["id"] = String(job.id); entry["serial"] = String(job.serial); entry["preset"] = String(job.preset);
  entry["asset"] = String(job.asset); entry["title"] = String(job.title); entry["at"] = static_cast<uint32_t>(time(nullptr));
  entry["attempts"] = job.attempts; entry["duration_ms"] = job.elapsed_ms; entry["confirmed"] = false;
}
void update_device_diagnostics(JsonObject device, const String &text) {
  int start = text.indexOf(" = "); if (start < 0) return;
  String hex = text.substring(start + 3); hex.trim();
  uint8_t data[128]; int size = 0;
  for (unsigned i = 0; i + 1 < hex.length() && size < 128; i += 3) {
    if (!isxdigit(hex[i]) || !isxdigit(hex[i + 1])) break;
    char pair[] = {hex[i], hex[i + 1], 0}; data[size++] = strtoul(pair, nullptr, 16);
  }
  JsonObject health = device["health"];
  if (health.isNull()) health = device.createNestedObject("health");
  health["last_reply"] = hex; health["measured_at"] = static_cast<uint32_t>(time(nullptr));
  for (int i = 0; i < size;) {
    uint8_t command = data[i++];
    if (!(command & 128)) continue;
    if (i >= size) break;
    int length = data[i++]; if (length > size - i) break;
    const uint8_t *p = data + i;
    if (command == 0x85 && length >= 2) health["voltage_mv"] = p[0] | (p[1] << 8);
    if (command == 0x9a && length >= 4) { health["height"] = p[0] | (p[1] << 8); health["width"] = p[2] | (p[3] << 8); }
    if (command == 0xe0 && length >= 4) {
      char version[24]; snprintf(version, sizeof(version), "%u.%u.%u.%u", p[0], p[1], p[2], p[3]); health["firmware"] = version;
    }
    if (command == 0xa6 && length >= 2) {
      JsonArray counters = health["update_counters"].to<JsonArray>();
      for (int j = 0; j + 1 < length; j += 2) counters.add(p[j] | (p[j + 1] << 8));
    }
    if (command == 0x9e) {
      String identity; for (int j = 0; j < length; ++j) { char byte[4]; snprintf(byte, 4, "%02X", p[j]); identity += byte; }
      health["internal_id"] = identity;
    }
    i += length;
  }
}
bool preset_used_by_automation(const String &id) {
  for (JsonObject plan : model["automations"].as<JsonArray>()) {
    if (plan["preset"].as<String>() == id) return true;
    for (JsonVariant preset : plan["presets"].as<JsonArray>()) if (preset.as<String>() == id) return true;
  }
  return false;
}
void automation_finished(const Job &job, const char *state) {
  if (!job.source[0]) return;
  JsonObject plan = find_item("automations", "id", job.source); if (plan.isNull()) return;
  plan["last_result"] = String(state); plan["last_job"] = String(job.id);
  if (strcmp(plan["kind"] | "", "playlist") == 0) {
    if (strcmp(state, "completed") == 0) {
      size_t count = plan["presets"].size();
      plan["cursor"] = count ? ((plan["cursor"] | 0) + 1) % count : 0;
      plan["next_at"] = static_cast<uint32_t>(time(nullptr)) + (plan["interval_seconds"] | 300);
    } else { plan["enabled"] = false; plan["last_result"] = String(state); }
  }
  mark_dirty();
}
bool queue_automation(JsonObject plan) {
  if (time(nullptr) < 1700000000) return false;
  int pending = uxQueueMessagesWaiting(actions);
  for (int i = 0; i < job_count; ++i) {
    if (live_job(jobs[i])) {
      ++pending;
      if (strcmp(jobs[i].serial, plan["serial"] | "") == 0 || strcmp(jobs[i].source, plan["id"] | "") == 0) return false;
    }
  }
  if (pending >= 8) return false;
  String preset = plan["preset"] | "";
  if (strcmp(plan["kind"] | "", "playlist") == 0) {
    JsonArray list = plan["presets"];
    if (!list.size()) return false;
    preset = list[(plan["cursor"] | 0) % list.size()].as<String>();
  }
  if (find_item("devices", "serial", plan["serial"] | "").isNull() || find_item("presets", "id", preset).isNull()) {
    plan["enabled"] = false; plan["last_result"] = "Missing display or saved screen"; mark_dirty(); return false;
  }
  Action action = {};
  snprintf(action.id, sizeof(action.id), "%08lx%04lx", (unsigned long)millis(), (unsigned long)(esp_random() & 65535));
  StaticJsonDocument<256> body; body["serial"] = plan["serial"].as<String>(); body["preset"] = preset; body["source"] = plan["id"].as<String>();
  add_job(action, body.as<JsonVariant>(), "send");
  plan["last_job"] = String(action.id); plan["last_result"] = "queued";
  String kind = plan["kind"] | "once"; uint32_t now = time(nullptr);
  if (kind == "once") plan["enabled"] = false;
  else if (kind == "daily") plan["next_at"] = next_daily(plan["hour"] | 0, plan["minute"] | 0, now);
  else if (kind == "playlist") plan["next_at"] = 0; // completion schedules the next entry
  else plan["next_at"] = now + (plan["interval_seconds"] | 300);
  mark_dirty(); return true;
}
void poll_automations() {
  static bool ntp_started = false;
  if (!ntp_started && WiFi.status() == WL_CONNECTED) {
    configTzTime(timezone_rule(model["settings"]["timezone"] | String("UTC")), "pool.ntp.org", "time.nist.gov"); ntp_started = true;
  }
  if (millis() - last_automation_tick < 1000) return;
  last_automation_tick = millis(); uint32_t now = time(nullptr);
  if (now < 1700000000) return;
  for (JsonObject plan : model["automations"].as<JsonArray>()) {
    if (!(plan["enabled"] | false)) continue;
    uint32_t due = plan["next_at"] | 0U;
    if (!due && strcmp(plan["kind"] | "", "playlist") != 0) {
      plan["next_at"] = strcmp(plan["kind"] | "", "daily") == 0 ? next_daily(plan["hour"] | 0, plan["minute"] | 0, now) : now + (plan["interval_seconds"] | 300);
      mark_dirty(); continue;
    }
    if ((due && due <= now) || (!due && strcmp(plan["last_result"] | "", "queued") != 0)) queue_automation(plan);
  }
}
bool valid_elements(JsonVariant body) {
  if (strcmp(body["kind"] | "", "layout") != 0) return true;
  JsonArray elements = body["elements"].as<JsonArray>();
  if (elements.isNull() || !elements.size() || elements.size() > 6) return false;
  unsigned text_length = 0;
  for (JsonObject element : elements) {
    String type = element["type"] | "";
    if (type != "text" && type != "rect" && type != "qr" && type != "image") return false;
    if (!safe_id(element["id"] | "")) return false;
    String color = element["color"] | "black";
    if (color != "black" && color != "white" && color != "yellow") return false;
    if (type == "text" && ((element["font_size"] | 32) < 12 || (element["font_size"] | 32) > 160)) return false;
    for (const char *key : {"x", "y", "w", "h"}) if (!element[key].is<int>() || !isfinite(element[key].as<double>())) return false;
    int x = element["x"], y = element["y"], w = element["w"], h = element["h"];
    if (x < 0 || y < 0 || w < 8 || h < 8 || x + w > 640 || y + h > 384) return false;
    text_length += element["text"].as<String>().length();
    if (type == "image" && (!safe_id(element["asset"] | "") || !SPIFFS.exists("/screen-" + element["asset"].as<String>() + ".bin"))) return false;
    if (element.containsKey("source_rect")) {
      JsonArray crop = element["source_rect"].as<JsonArray>(); if (crop.size() != 4) return false;
      for (JsonVariant value : crop) if (!value.is<float>() || !isfinite(value.as<double>()) || value.as<float>() < 0) return false;
      if (crop[2].as<float>() <= 0 || crop[3].as<float>() <= 0 || crop[0].as<float>() + crop[2].as<float>() > 640.01 || crop[1].as<float>() + crop[3].as<float>() > 384.01) return false;
    }
  }
  return text_length <= 600;
}
bool valid_automation(JsonVariant body, String &error) {
  String id = body["id"] | "", kind = body["kind"] | "", name = body["name"] | "";
  if (!safe_id(id) || name.length() < 1 || name.length() > 40 || find_item("devices", "serial", body["serial"] | "").isNull()) { error = "Choose a name and a registered display"; return false; }
  if (kind != "once" && kind != "daily" && kind != "interval" && kind != "playlist") { error = "Unsupported automation type"; return false; }
  if (kind == "playlist") {
    JsonArray list = body["presets"].as<JsonArray>();
    if (list.isNull() || !list.size() || list.size() > 10) { error = "Choose 1 to 10 saved screens"; return false; }
    for (JsonVariant id : list) if (find_item("presets", "id", id.as<String>()).isNull()) { error = "Playlist screen not found"; return false; }
  } else if (find_item("presets", "id", body["preset"] | "").isNull()) { error = "Choose a saved screen"; return false; }
  if ((kind == "playlist" || kind == "interval") && ((body["interval_seconds"] | 0) < 300 || (body["interval_seconds"] | 0) > 604800)) { error = "Use an interval between 5 minutes and 7 days"; return false; }
  if (kind == "daily" && ((body["hour"] | -1) < 0 || (body["hour"] | 24) > 23 || (body["minute"] | -1) < 0 || (body["minute"] | 60) > 59)) { error = "Choose a valid daily time"; return false; }
  if (kind == "once" && (body["next_at"] | 0U) < static_cast<uint32_t>(time(nullptr)) + 3) { error = "Choose a future time"; return false; }
  if (find_item("automations", "id", id).isNull() && model["automations"].size() >= 12) { error = "The controller supports 12 automations"; return false; }
  return true;
}
