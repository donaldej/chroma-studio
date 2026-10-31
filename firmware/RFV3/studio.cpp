#ifdef CHROMA_T_EMBED_CC1101
#include <Arduino.h>
#include <ArduinoJson.h>
#include <AsyncJson.h>
#include <ESPAsyncWebServer.h>
#include <SPIFFS.h>
#include <WiFi.h>
#include "studio.h"
#include "RFV3.h"
#include "main_variables.h"
#include "trans_assist.h"
#include "cc1101_spi.h"
#include "cc1101.h"

namespace {
DynamicJsonDocument model(24576);
SemaphoreHandle_t model_mutex;
QueueHandle_t actions;
struct Action { char type[24]; char id[17]; char json[1536]; };
struct Job {
  char id[17], serial[12], preset[33], asset[33], title[49], state[17], kind[12], error[97];
  uint32_t started, finished, total, remaining;
  bool prepared;
};
Job jobs[12] = {};
int job_count = 0, active = -1;
bool radio_ready = false;
bool dirty = false;
uint32_t last_persist = 0;
String radio_mode = "Starting";
uint32_t revision = 0;
volatile unsigned uploads_active = 0;
struct StagedAsset { char id[33]; uint32_t created; };
StagedAsset staged[8] = {};
unsigned staged_index = 0;
uint32_t last_gc = 0;
uint32_t storage_total = 0, storage_used = 0, last_storage_check = 0;
uint8_t inspected_regs[47] = {}, inspected_pins[12] = {}, inspected_version = 0, inspected_state = 0;
uint32_t inspected_at = 0;
bool radio_service_mode = false, restarting = false;
bool direct_radio = true;
uint32_t restart_at = 0;
const uint8_t diagnostic_pins[] = {12, 41, 13, 44, 43, 15, 47, 48, 21, 4, 5, 38};

struct Lock {
  Lock() { xSemaphoreTake(model_mutex, portMAX_DELAY); }
  ~Lock() { xSemaphoreGive(model_mutex); }
};
struct TryLock {
  bool acquired;
  TryLock() : acquired(xSemaphoreTake(model_mutex, 0) == pdPASS) {}
  ~TryLock() { if (acquired) xSemaphoreGive(model_mutex); }
};

bool safe_id(const String &value) {
  if (!value.length() || value.length() > 32) return false;
  for (char c : value) if (!isalnum(static_cast<unsigned char>(c)) && c != '-' && c != '_') return false;
  return true;
}
bool valid_serial(const String &serial) {
  if (serial.length() != 11 || !isupper(serial[0]) || !isupper(serial[1]) ||
      (serial[10] != 'B' && serial[10] != 'C')) return false;
  for (int i = 2; i < 10; ++i) if (!isdigit(serial[i])) return false;
  return true;
}
JsonObject find_item(const char *collection, const char *key, const String &value) {
  for (JsonObject item : model[collection].as<JsonArray>())
    if (item[key].as<String>() == value) return item;
  return JsonObject();
}
void mark_dirty() { dirty = true; ++revision; }
bool save_handoff_jobs() {
  DynamicJsonDocument doc(12288);
  JsonArray list = doc.to<JsonArray>();
  for (int i = 0; i < job_count; ++i) {
    const Job &job = jobs[i]; JsonObject item = list.createNestedObject();
    item["id"] = job.id; item["serial"] = job.serial; item["preset"] = job.preset; item["asset"] = job.asset;
    item["title"] = job.title; item["state"] = job.state; item["kind"] = job.kind; item["error"] = job.error;
    item["started"] = job.started; item["finished"] = job.finished; item["total"] = job.total; item["remaining"] = job.remaining;
  }
  File file = SPIFFS.open("/handoff-jobs.tmp", "w");
  if (!file) return false;
  size_t written = serializeJson(doc, file); file.close();
  if (written != measureJson(doc)) return false;
  SPIFFS.remove("/handoff-jobs.json");
  return SPIFFS.rename("/handoff-jobs.tmp", "/handoff-jobs.json");
}
void load_handoff_jobs() {
  File file = SPIFFS.open("/handoff-jobs.json", "r");
  if (!file) return;
  DynamicJsonDocument doc(12288);
  if (deserializeJson(doc, file) || !doc.is<JsonArray>()) return;
  for (JsonObject item : doc.as<JsonArray>()) {
    if (job_count == 12) break;
    Job &job = jobs[job_count++]; memset(&job, 0, sizeof(job));
    strlcpy(job.id, item["id"] | "", sizeof(job.id));
    strlcpy(job.serial, item["serial"] | "", sizeof(job.serial));
    strlcpy(job.preset, item["preset"] | "", sizeof(job.preset));
    strlcpy(job.asset, item["asset"] | "", sizeof(job.asset));
    strlcpy(job.title, item["title"] | "", sizeof(job.title));
    strlcpy(job.state, item["state"] | "failed", sizeof(job.state));
    strlcpy(job.kind, item["kind"] | "send", sizeof(job.kind));
    strlcpy(job.error, item["error"] | "", sizeof(job.error));
    job.started = item["started"] | 0; job.finished = item["finished"] | 0;
    job.total = item["total"] | 0; job.remaining = item["remaining"] | 0;
    if (strcmp(job.state, "sending") == 0) {
      strlcpy(job.state, "failed", sizeof(job.state));
      strlcpy(job.error, "Controller restarted during transfer", sizeof(job.error));
    }
  }
  file.close();
  if (!radio_service_mode) SPIFFS.remove("/handoff-jobs.json");
}
void prune_assets() {
  if (uploads_active) return;
  File root = SPIFFS.open("/");
  File file = root.openNextFile();
  while (file) {
    String path = file.name(); file.close();
    if (!path.startsWith("/")) path = "/" + path;
    if (path.startsWith("/screen-") && path.endsWith(".bin")) {
      String id = path.substring(8, path.length() - 4);
      bool referenced = false;
      for (JsonObject preset : model["presets"].as<JsonArray>())
        if (preset["asset"].as<String>() == id) referenced = true;
      for (int i = 0; i < job_count; ++i)
        if ((strcmp(jobs[i].state, "queued") == 0 || strcmp(jobs[i].state, "sending") == 0) && id == jobs[i].asset) referenced = true;
      for (const StagedAsset &asset : staged)
        if (id == asset.id && millis() - asset.created < 60000) referenced = true;
      if (!referenced) SPIFFS.remove(path);
    }
    file = root.openNextFile();
  }
}
void persist() {
  File file = SPIFFS.open("/studio.tmp", "w");
  if (!file) return;
  size_t written = serializeJson(model, file);
  file.close();
  if (!written) return;
  SPIFFS.remove("/studio.bak");
  if (SPIFFS.exists("/studio.json")) SPIFFS.rename("/studio.json", "/studio.bak");
  if (SPIFFS.rename("/studio.tmp", "/studio.json")) dirty = false;
}
void error_response(AsyncWebServerRequest *request, int code, const String &message) {
  StaticJsonDocument<256> doc;
  doc["error"] = message;
  String out; serializeJson(doc, out);
  request->send(code, "application/json", out);
}
bool push_action(const char *type, JsonVariant body, String &id) {
  Action action = {};
  strlcpy(action.type, type, sizeof(action.type));
  snprintf(action.id, sizeof(action.id), "%08lx%04lx", static_cast<unsigned long>(millis()),
           static_cast<unsigned long>(esp_random() & 0xffff));
  if (measureJson(body) >= sizeof(action.json)) return false;
  serializeJson(body, action.json, sizeof(action.json));
  if (xQueueSend(actions, &action, 0) != pdPASS) return false;
  id = action.id;
  return true;
}
bool live_job(const Job &job) {
  return strcmp(job.state, "queued") == 0 || strcmp(job.state, "sending") == 0;
}
void add_job(const Action &action, JsonVariant body, const char *kind) {
  if (job_count == 12) {
    int remove = -1;
    for (int i = 0; i < job_count; ++i) if (!live_job(jobs[i])) { remove = i; break; }
    if (remove < 0) return;
    for (int i = remove; i < job_count - 1; ++i) jobs[i] = jobs[i + 1];
    if (active > remove) --active;
    --job_count;
  }
  Job &job = jobs[job_count++];
  memset(&job, 0, sizeof(job));
  strlcpy(job.id, action.id, sizeof(job.id));
  strlcpy(job.serial, body["serial"] | "", sizeof(job.serial));
  strlcpy(job.preset, body["preset"] | "", sizeof(job.preset));
  strlcpy(job.kind, kind, sizeof(job.kind));
  strlcpy(job.state, "queued", sizeof(job.state));
  JsonObject preset = find_item("presets", "id", job.preset);
  strlcpy(job.asset, preset["asset"] | "", sizeof(job.asset));
  strlcpy(job.title, strcmp(kind, "activate") == 0 ? "Pair display" : (preset["name"] | "Saved screen"), sizeof(job.title));
  ++revision;
}
void finish_job(const char *state, const char *error = "") {
  if (active < 0) return;
  Job &job = jobs[active];
  strlcpy(job.state, state, sizeof(job.state));
  strlcpy(job.error, error, sizeof(job.error));
  job.finished = millis();
  local_ui_finish_transfer(job.id);
  if (strcmp(state, "failed") == 0) radio_ready = false;
  if (strcmp(state, "completed") == 0) {
    job.remaining = 0;
    JsonObject device = find_item("devices", "serial", job.serial);
    if (!device.isNull()) {
      device["last_ack"] = millis();
      if (job.preset[0]) device["last_preset"] = job.preset;
      mark_dirty();
    }
  }
  active = -1;
  ++revision;
}
String state_json(const char *section = nullptr) {
  Lock lock;
  DynamicJsonDocument doc(32768);
  doc["revision"] = revision;
  JsonObject controller = doc.createNestedObject("controller");
  controller["name"] = "Chroma Studio";
  controller["version"] = "0.2.0";
  controller["radio_service"] = radio_service_mode;
  controller["direct_radio"] = direct_radio;
  controller["ip"] = WiFi.localIP().toString();
  controller["connected"] = WiFi.status() == WL_CONNECTED;
  controller["uptime_ms"] = millis();
  controller["heap_free"] = ESP.getFreeHeap();
  controller["storage_used"] = storage_used;
  controller["storage_total"] = storage_total;
  controller["radio_mode"] = radio_mode;
  controller["discarded_radio_edges"] = studio_discarded_radio_edges();
  controller["lcd_transfer_progress"] = local_ui_transfer_progress();
  controller["lcd_progress_updates"] = local_ui_progress_updates();
  if (inspected_at) {
    JsonObject inspect = controller.createNestedObject("radio_debug");
    inspect["at"] = inspected_at; inspect["version"] = inspected_version; inspect["state"] = inspected_state;
    JsonArray regs = inspect.createNestedArray("registers");
    for (uint8_t value : inspected_regs) regs.add(value);
    JsonObject pins = inspect.createNestedObject("pins");
    for (size_t i = 0; i < sizeof(diagnostic_pins); ++i) pins[String(diagnostic_pins[i])] = inspected_pins[i];
  }
  controller["channel"] = get_freq();
  controller["network_id"] = get_network_id();
  doc["devices"] = model["devices"];
  doc["presets"] = model["presets"];
  JsonArray list = doc.createNestedArray("jobs");
  for (int i = job_count - 1; i >= 0; --i) {
    const Job &job = jobs[i];
    JsonObject item = list.createNestedObject();
    item["id"] = job.id; item["serial"] = job.serial; item["preset"] = job.preset;
    item["title"] = job.title; item["state"] = job.state; item["kind"] = job.kind;
    item["error"] = job.error; item["total"] = job.total; item["remaining"] = job.remaining;
    item["started"] = job.started; item["finished"] = job.finished;
    item["progress"] = strcmp(job.state, "completed") == 0 ? 100 :
      (job.total ? min(99U, (job.total - min(job.remaining, job.total)) * 100 / job.total) : 0);
  }
  String out;
  if (section) serializeJson(doc[section], out); else serializeJson(doc, out);
  return out;
}
struct Upload { char path[64]; size_t bytes; bool okay; bool finished; };
bool valid_asset(const String &path) {
  File file = SPIFFS.open(path, "r");
  if (!file || file.size() < 39 || file.size() > 65535) return false;
  uint8_t header[32];
  if (file.read(header, sizeof(header)) != sizeof(header)) return false;
  unsigned size = header[7] | (header[8] << 8);
  if (header[0] != 0x83 || header[1] != 0x19 || header[3] != 0x80 || header[4] != 2 ||
      header[5] != 0x80 || header[6] != 1 || header[28] != 0x80 ||
      (header[23] != 0 && header[23] != 2) || (header[26] != 0 && header[26] != 0x21) || file.size() != size + 39) return false;
  if (header[23] == 0) {
    if (size != (header[26] == 0x21 ? 61440 : 30720)) return false;
    uint32_t sum = 0;
    uint8_t buffer[512];
    unsigned left = size;
    while (left) {
      size_t amount = file.read(buffer, min(static_cast<unsigned>(sizeof(buffer)), left));
      if (!amount) return false;
      for (size_t i = 0; i < amount; ++i) sum += buffer[i];
      left -= amount;
    }
    if (static_cast<uint8_t>(-sum) != header[22]) return false;
  }
  file.seek(size + 32);
  uint8_t trailer[7], expected[7] = {0x85, 0x05, 0x08, 0, 0, 1, 1};
  return file.read(trailer, 7) == 7 && memcmp(trailer, expected, 7) == 0;
}
}

void init_studio() {
  model_mutex = xSemaphoreCreateMutex();
  actions = xQueueCreate(8, sizeof(Action));
  radio_service_mode = SPIFFS.exists("/radio-mode");
  storage_total = SPIFFS.totalBytes(); storage_used = SPIFFS.usedBytes();
  File file = SPIFFS.open("/studio.json", "r");
  if (!file) file = SPIFFS.open("/studio.bak", "r");
  if (file) { if (deserializeJson(model, file)) model.clear(); file.close(); }
  if (!model["devices"].is<JsonArray>()) model.createNestedArray("devices");
  if (!model["presets"].is<JsonArray>()) model.createNestedArray("presets");
  load_handoff_jobs();
  for (JsonObject device : model["devices"].as<JsonArray>()) device["last_ack"] = 0;

}

bool studio_send(const String &serial, const String &preset, String &id, String &error) {
  Lock lock;
  if (restarting) { error = "Controller is switching modes; try again in a moment"; return false; }
  if (find_item("devices", "serial", serial).isNull()) { error = "Display not found"; return false; }
  JsonObject item = find_item("presets", "id", preset);
  if (item.isNull() || !SPIFFS.exists("/screen-" + item["asset"].as<String>() + ".bin")) {
    error = "Saved screen not found"; return false;
  }
  int pending = 0;
  for (int i = 0; i < job_count; ++i) if (live_job(jobs[i])) ++pending;
  if (pending + uxQueueMessagesWaiting(actions) >= 8) { error = "The transfer queue is full"; return false; }
  StaticJsonDocument<192> doc;
  doc["serial"] = serial; doc["preset"] = preset;
  if (!push_action("send", doc.as<JsonVariant>(), id)) { error = "Controller is busy; try again"; return false; }
  return true;
}

void studio_radio_mode(const String &mode) { TryLock lock; if (lock.acquired) radio_mode = mode; }
bool studio_radio_service() { return radio_service_mode; }

void poll_studio() {
  static uint32_t last_poll = 0;
  if (millis() - last_poll < 5) return;
  last_poll = millis();
  TryLock lock;
  if (!lock.acquired) return;
  if (restarting) {
    if (static_cast<int32_t>(millis() - restart_at) >= 0) {
      end_trans_file(); digitalWrite(21, LOW); digitalWrite(15, LOW);
      delay(100); ESP.restart();
    }
    return;
  }
  radio_mode = get_mode_string();
  Action action;
  if (xQueueReceive(actions, &action, 0) == pdPASS) {
    StaticJsonDocument<2048> doc;
    // Read-only input makes ArduinoJson own its strings. The mutable queue
    // buffer is reused next loop and must never back persistent model values.
    if (!deserializeJson(doc, static_cast<const char *>(action.json))) {
      JsonVariant body = doc.as<JsonVariant>();
      String type = action.type;
      if (type == "send" || type == "activate") add_job(action, body, type == "send" ? "send" : "activate");
      else if (type == "diagnostics") {
        if (body.containsKey("direct")) direct_radio = body["direct"].as<bool>();
        local_ui_diagnostics(body["backlight"] | true, body["encoder"] | true, body["redraw"] | true);
        if ((body["inspect"] | false) && active < 0) {
          for (int i = 0; i < 47; ++i) inspected_regs[i] = spi_read_register(i);
          for (size_t i = 0; i < sizeof(diagnostic_pins); ++i) inspected_pins[i] = digitalRead(diagnostic_pins[i]);
          inspected_version = spi_read_register(CC1101_STATUS_VERSION);
          inspected_state = spi_read_register(CC1101_STATUS_MARCSTATE) & 31;
          inspected_at = millis();
        }
      }
      else if (type == "device.save" || type == "preset.save") {
        const char *collection = type == "device.save" ? "devices" : "presets";
        const char *key = type == "device.save" ? "serial" : "id";
        JsonObject item = find_item(collection, key, body[key].as<String>());
        if (item.isNull()) item = model[collection].createNestedObject();
        if (type == "device.save") {
          const char *keys[] = {"serial", "name", "id", "palette", "channel", "network", "wake_channel"};
          for (const char *key : keys) if (!body[key].isNull()) {
            if (strcmp(key, "serial") == 0 || strcmp(key, "name") == 0 || strcmp(key, "palette") == 0) item[key] = body[key].as<String>();
            else item[key] = body[key].as<int>();
          }
        } else {
          const char *keys[] = {"id", "name", "asset", "text", "color", "background", "font_size", "align", "font", "template", "kind"};
          for (const char *key : keys) if (!body[key].isNull()) {
            if (strcmp(key, "font_size") == 0) item[key] = body[key].as<int>();
            else item[key] = body[key].as<String>();
          }
        }
        model.garbageCollect();
        mark_dirty();
      } else if (type == "preset.delete") {
        JsonArray list = model["presets"].as<JsonArray>();
        for (size_t i = 0; i < list.size(); ++i) if (list[i]["id"].as<String>() == body["id"].as<String>()) {
          String asset = list[i]["asset"] | "";
          bool referenced = false;
          for (int j = 0; j < job_count; ++j)
            if (live_job(jobs[j]) && strcmp(jobs[j].preset, body["id"] | "") == 0) referenced = true;
          if (!referenced) { list.remove(i); model.garbageCollect(); mark_dirty(); }
          break;
        }
      } else if (type == "device.delete") {
        JsonArray list = model["devices"].as<JsonArray>();
        for (size_t i = 0; i < list.size(); ++i) if (list[i]["serial"].as<String>() == body["serial"].as<String>()) {
          list.remove(i); model.garbageCollect(); mark_dirty(); break;
        }
      } else if (type == "cancel") {
        for (int i = 0; i < job_count; ++i) if (strcmp(jobs[i].id, body["id"] | "") == 0 && live_job(jobs[i])) {
          if (i == active) {
            if (get_trans_mode()) { set_trans_mode(0); restore_current_settings(); }
            set_is_data_waiting(0); end_trans_file(); set_mode_idle();
            finish_job("cancelled");
          } else { strlcpy(jobs[i].state, "cancelled", sizeof(jobs[i].state)); jobs[i].finished = millis(); local_ui_finish_transfer(jobs[i].id); ++revision; }
        }
      }
    }
  }
  if (active >= 0) {
    Job &job = jobs[active];
    if (strcmp(job.kind, "activate") == 0) {
      if (get_last_activation_status() == 3) finish_job("completed");
      else if (get_last_activation_status() == 2) finish_job("failed", "Display did not answer activation");
    } else {
      if (get_still_to_send() > 0) job.remaining = min(job.total, static_cast<uint32_t>(get_still_to_send()));
      if (get_last_send_status() == 3 && !get_is_data_waiting_raw()) finish_job("completed");
      else if (get_last_send_status() == 2) finish_job("failed", "Display acknowledgement timed out");
    }
    if (active >= 0 && millis() - jobs[active].started > 240000) {
      set_is_data_waiting(0); end_trans_file(); set_mode_idle();
      finish_job("failed", "Transfer exceeded four minutes");
    }
  }
  if (active < 0 && !get_is_data_waiting_raw() && radio_mode == "Idle") {
    for (int i = 0; i < job_count; ++i) if (strcmp(jobs[i].state, "queued") == 0) {
      Job &job = jobs[i];
      JsonObject device = find_item("devices", "serial", job.serial);
      if (device.isNull()) { active = i; finish_job("failed", "Display was removed"); break; }
      if (!radio_service_mode && !direct_radio) {
        if (uploads_active || uxQueueMessagesWaiting(actions)) break;
        if (dirty) persist();
        if (!save_handoff_jobs()) { active = i; finish_job("failed", "Could not save the transfer queue"); break; }
        File marker = SPIFFS.open("/radio-mode", "w");
        if (!marker) { active = i; finish_job("failed", "Could not prepare radio service"); break; }
        marker.print("1"); marker.close();
        restarting = true; restart_at = millis() + 500;
        break;
      }
      if (!job.prepared) {
        if (!local_ui_prepare_transfer(job.id, job.title)) break;
        job.prepared = true;
        if (!radio_service_mode) radio_ready = false;
      }
      bool changed_network = get_freq() != (device["channel"] | 0) || get_network_id() != (device["network"] | 1);
      set_freq(device["channel"] | 0); set_network_id(device["network"] | 1);
      set_wu_channel(device["wake_channel"] | 4);
      if (strcmp(job.kind, "send") == 0 && (!radio_ready || changed_network)) {
        // A reboot changes the controller's slot clock. Wake and synchronize
        // paired tags before sending instead of repeatedly retrying packet zero.
        radio_ready = true;
        set_mode_wu();
        break;
      }
      active = i;
      job.started = millis();
      strlcpy(job.state, "sending", sizeof(job.state));
      set_last_to_short(false); // Each job starts a fresh protocol stream.
      set_display_id(device["id"] | 123);
      if (radio_service_mode) save_handoff_jobs();
      if (strcmp(job.kind, "activate") == 0) {
        uint8_t serial[7] = {static_cast<uint8_t>(job.serial[0]), static_cast<uint8_t>(job.serial[1])};
        for (int j = 0; j < 4; ++j) serial[j + 2] = ((job.serial[j * 2 + 2] - '0') << 4) | (job.serial[j * 2 + 3] - '0');
        serial[6] = job.serial[10]; set_serial(serial); set_last_activation_status(1);
        if (serial[6] == 'C') set_mode_wun_activation(); else set_mode_wu_activation();
      } else {
        String path = "/screen-" + String(job.asset) + ".bin";
        int size = set_trans_file(path);
        if (!size) { finish_job("failed", "Saved screen file is missing"); break; }
        job.total = size; job.remaining = size;
        set_still_to_send(size);
        set_is_data_waiting(device["id"] | 123);
      }
      ++revision;
      break;
    }
  }
  if (radio_service_mode && active < 0 && !uploads_active && !uxQueueMessagesWaiting(actions) && millis() > 5000 && radio_mode == "Idle") {
    bool pending = false;
    for (int i = 0; i < job_count; ++i) if (live_job(jobs[i])) pending = true;
    if (!pending) {
      if (dirty) persist();
      if (save_handoff_jobs()) {
        SPIFFS.remove("/radio-mode");
        restarting = true; restart_at = millis() + 500;
      }
    }
  }
  if (dirty && active < 0 && radio_mode == "Idle" && millis() - last_persist > 2000) { persist(); last_persist = millis(); }
  if (active < 0 && radio_mode == "Idle" && millis() - last_gc > 60000) { prune_assets(); last_gc = millis(); }
  if (active < 0 && radio_mode == "Idle" && millis() - last_storage_check > 10000) {
    storage_used = SPIFFS.usedBytes(); last_storage_check = millis();
  }
}

void studio_menu(StudioMenu &menu) {
  Lock lock;
  memset(&menu, 0, sizeof(menu));
  for (JsonObject item : model["devices"].as<JsonArray>()) {
    if (menu.device_count == 12) break;
    strlcpy(menu.serials[menu.device_count], item["serial"] | "", 12);
    strlcpy(menu.devices[menu.device_count++], item["name"] | "Display", 41);
  }
  for (JsonObject item : model["presets"].as<JsonArray>()) {
    if (menu.preset_count == 20) break;
    strlcpy(menu.preset_ids[menu.preset_count], item["id"] | "", 33);
    strlcpy(menu.presets[menu.preset_count++], item["name"] | "Saved screen", 41);
  }
  for (int i = 0; i < job_count; ++i) if (strcmp(jobs[i].state, "queued") == 0) ++menu.queued;
  if (job_count) {
    const Job &job = jobs[active >= 0 ? active : job_count - 1];
    strlcpy(menu.job, job.title, sizeof(menu.job)); strlcpy(menu.job_state, job.state, sizeof(menu.job_state));
    menu.progress = strcmp(job.state, "completed") == 0 ? 100 :
      (job.total ? min(99U, (job.total - min(job.remaining, job.total)) * 100 / job.total) : 0);
  }
}

void register_studio_routes(AsyncWebServer &server) {
  server.on("/api/v1/assets", HTTP_POST, [](AsyncWebServerRequest *request) {
    Upload *upload = static_cast<Upload *>(request->_tempObject);
    if (!upload || !upload->okay || !valid_asset(upload->path)) {
      if (upload) { Lock lock; upload->finished = true; if (uploads_active) --uploads_active; SPIFFS.remove(upload->path); }
      error_response(request, 400, "Invalid screen file; expected a 640 x 384 display command"); return;
    }
    StaticJsonDocument<160> doc;
    String path = upload->path;
    String id = path.substring(8, path.length() - 4);
    { Lock lock; strlcpy(staged[staged_index].id, id.c_str(), 33); staged[staged_index].created = millis(); staged_index = (staged_index + 1) % 8; upload->finished = true; if (uploads_active) --uploads_active; }
    doc["asset"] = id; doc["bytes"] = upload->bytes;
    String out; serializeJson(doc, out); request->send(201, "application/json", out);
  }, [](AsyncWebServerRequest *request, const String &filename, size_t index, uint8_t *data, size_t len, bool final) {
    if (index == 0) {
      if (request->_tempObject) { static_cast<Upload *>(request->_tempObject)->okay = false; return; }
      Upload *upload = static_cast<Upload *>(calloc(1, sizeof(Upload)));
      request->_tempObject = upload;
      if (!upload) return;
      request->onDisconnect([request]() {
        Upload *pending = static_cast<Upload *>(request->_tempObject);
        if (pending && !pending->finished) {
          Lock lock; pending->finished = true;
          if (uploads_active) --uploads_active;
          request->_tempFile.close();
          if (pending->path[0]) SPIFFS.remove(pending->path);
        }
      });
      Lock lock;
      ++uploads_active;
      String id = filename; if (id.endsWith(".bin")) id.remove(id.length() - 4);
      if (!safe_id(id) || SPIFFS.exists("/screen-" + id + ".bin") || SPIFFS.totalBytes() - SPIFFS.usedBytes() < 80000) return;
      snprintf(upload->path, sizeof(upload->path), "/screen-%s.bin", id.c_str());
      request->_tempFile = SPIFFS.open(upload->path, "w"); upload->okay = static_cast<bool>(request->_tempFile);
    }
    Upload *upload = static_cast<Upload *>(request->_tempObject);
    if (!upload) return;
    if (upload->bytes + len > 65535) upload->okay = false;
    if (upload->okay && request->_tempFile.write(data, len) != len) upload->okay = false;
    upload->bytes += len;
    if (final) request->_tempFile.close();
  });
  server.on("/api/v1", HTTP_GET, [](AsyncWebServerRequest *request) {
    String path = request->url();
    if (path.startsWith("/api/v1/assets/")) {
      String id = path.substring(15);
      if (!safe_id(id) || !SPIFFS.exists("/screen-" + id + ".bin")) { error_response(request, 404, "Screen file not found"); return; }
      request->send(SPIFFS, "/screen-" + id + ".bin", "application/octet-stream"); return;
    }
    if (path == "/api/v1/state" || path == "/api/v1/displays" || path == "/api/v1/presets" || path == "/api/v1/jobs") {
      const char *section = path.endsWith("/displays") ? "devices" : path.endsWith("/presets") ? "presets" : path.endsWith("/jobs") ? "jobs" : nullptr;
      request->send(200, "application/json", state_json(section)); return;
    }
    if (path == "/api/v1/export") {
      Lock lock; String out; serializeJson(model, out);
      auto *response = request->beginResponse(200, "application/json", out);
      response->addHeader("Content-Disposition", "attachment; filename=chroma-studio.json"); request->send(response); return;
    }
    error_response(request, 404, "API endpoint not found");
  });
  auto *json = new AsyncCallbackJsonWebHandler("/api/v1", [](AsyncWebServerRequest *request, JsonVariant &body) {
    if (restarting) { error_response(request, 503, "Controller is switching modes; try again in a moment"); return; }
    if (!body.is<JsonObject>()) { error_response(request, 400, "Expected a JSON object"); return; }
    String path = request->url(), type, id, error;
    if (path == "/api/v1/jobs") {
      if (!studio_send(body["serial"] | "", body["preset"] | "", id, error)) { error_response(request, 409, error); return; }
    } else {
      Lock lock;
      if (path == "/api/v1/displays") {
        String serial = body["serial"] | "", name = body["name"] | "";
        int display_id = body["id"] | 0;
        int channel = body["channel"] | 0, network = body["network"] | 1, wake = body["wake_channel"] | 4;
        if (!valid_serial(serial) || name.length() < 1 || name.length() > 40 || display_id < 1 || display_id > 65534 ||
            channel < 0 || channel > 72 || network < 1 || network > 253 || wake < 0 || wake > 72) {
          error_response(request, 400, "Check the serial, display ID, name, and radio settings"); return;
        }
        if (find_item("devices", "serial", serial).isNull() && model["devices"].size() >= 12) {
          error_response(request, 409, "This controller supports up to 12 saved displays"); return;
        }
        for (JsonObject device : model["devices"].as<JsonArray>()) {
          if (device["serial"].as<String>() != serial && (device["id"] | 0) == display_id &&
              (device["channel"] | 0) == channel && (device["network"] | 1) == network) {
            error_response(request, 409, "Another display already uses that ID on this radio network"); return;
          }
        }
        String palette = body["palette"] | "bwy";
        if (palette != "bwy" && palette != "bwr") { error_response(request, 400, "Unsupported display palette"); return; }
        type = "device.save";
      } else if (path == "/api/v1/presets") {
        String preset_id = body["id"] | "", name = body["name"] | "", asset = body["asset"] | "";
        if (!safe_id(preset_id) || !safe_id(asset) || name.length() < 1 || name.length() > 40 ||
            !SPIFFS.exists("/screen-" + asset + ".bin") || (body["text"] | String("")).length() > 500) {
          error_response(request, 400, "A saved screen needs a name and a valid uploaded image"); return;
        }
        if (find_item("presets", "id", preset_id).isNull() && model["presets"].size() >= 20) {
          error_response(request, 409, "The saved-screen library is full (20 screens)"); return;
        }
        type = "preset.save";
      } else if (path == "/api/v1/presets/delete") {
        if (find_item("presets", "id", body["id"] | "").isNull()) { error_response(request, 404, "Saved screen not found"); return; }
        for (int i = 0; i < job_count; ++i) if (live_job(jobs[i]) && strcmp(jobs[i].preset, body["id"] | "") == 0) {
          error_response(request, 409, "Finish or cancel this screen's queued transfers before deleting it"); return;
        }
        type = "preset.delete";
      } else if (path == "/api/v1/displays/delete") {
        if (find_item("devices", "serial", body["serial"] | "").isNull()) { error_response(request, 404, "Display not found"); return; }
        for (int i = 0; i < job_count; ++i) if (live_job(jobs[i]) && strcmp(jobs[i].serial, body["serial"] | "") == 0) {
          error_response(request, 409, "Finish or cancel this display's queued transfers before removing it"); return;
        }
        type = "device.delete";
      }
      else if (path == "/api/v1/diagnostics") type = "diagnostics";
      else if (path == "/api/v1/jobs/cancel") type = "cancel";
      else if (path == "/api/v1/displays/activate") {
        if (find_item("devices", "serial", body["serial"] | "").isNull()) { error_response(request, 404, "Display not found"); return; }
        int pending = uxQueueMessagesWaiting(actions);
        for (int i = 0; i < job_count; ++i) if (live_job(jobs[i])) ++pending;
        if (pending >= 8) { error_response(request, 429, "The transfer queue is full"); return; }
        type = "activate";
      } else { error_response(request, 404, "API endpoint not found"); return; }
      if ((type == "device.save" || type == "preset.save") && model.memoryUsage() + measureJson(body) + 1024 > model.capacity()) {
        error_response(request, 409, "Saved-screen metadata storage is full; remove an unused screen"); return;
      }
      if (!push_action(type.c_str(), body, id)) { error_response(request, 429, "Controller queue is full; try again"); return; }
    }
    StaticJsonDocument<128> doc; doc["id"] = id; doc["accepted"] = true;
    String out; serializeJson(doc, out); request->send(202, "application/json", out);
  }, 2048);
  json->setMaxContentLength(1536);
  server.addHandler(json);
}
#endif
