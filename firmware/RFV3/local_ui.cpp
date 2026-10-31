#ifdef CHROMA_T_EMBED_CC1101
#include <Arduino.h>
#include <Adafruit_ST7789.h>
#include <WiFi.h>
#include <esp_sleep.h>
#include <driver/rtc_io.h>
#include "studio.h"
#include "interval_timer.h"

extern SPIClass *vspi;

namespace {
// Small text adapter keeps the menu layout independent of the SPI driver.
class MenuLCD {
  Adafruit_ST7789 *panel = nullptr;
public:
  void init() { panel = new Adafruit_ST7789(vspi, 41, 16, -1); panel->init(170, 320, SPI_MODE3); panel->setSPISpeed(20000000); panel->invertDisplay(true); }
  void setRotation(int rotation) { panel->setRotation(rotation); }
  void setTextWrap(bool wrap) { panel->setTextWrap(wrap); }
  void sleep(bool enabled) { panel->enableSleep(enabled); studio_discard_radio_edges(); }
  void startWrite() {} // Each GFX primitive owns its complete SPI transaction.
  void endWrite() {}
  void fillScreen(uint16_t color) { panel->fillScreen(color); }
  void setTextColor(uint16_t fg, uint16_t bg) { panel->setTextColor(fg, bg); }
  void fillRoundRect(int x, int y, int w, int h, int r, uint16_t color) { panel->fillRoundRect(x,y,w,h,r,color); }
  void drawFastHLine(int x,int y,int w,uint16_t color) { panel->drawFastHLine(x,y,w,color); }
  int textWidth(const String &value, int font) { return value.length() * (font == 1 ? 6 : 12); }
  void drawString(const String &value,int x,int y,int font) { panel->setTextSize(font == 1 ? 1 : 2); panel->setCursor(x,y); panel->print(value); }
  void drawRightString(const String &value,int x,int y,int font) { drawString(value,x-textWidth(value,font),y,font); }
};
MenuLCD lcd;
StudioMenu menu;
enum Page { HOME, DEVICES, SCREENS, CONFIRM, ACTIVITY, NETWORK, POWER, POWER_CONFIRM, RESULT };
Page page = HOME;
int selection = 0, device_index = 0, preset_index = 0;
bool dirty = true;
bool redraw_enabled = true;
bool transfer_screen = false;
bool panel_sleeping = false, backlight_requested = true, encoder_requested = true;
bool screen_off = false, wake_release = false;
enum PowerAction { NONE, SHUTDOWN, REBOOT, SCREEN_OFF };
PowerAction power_action = NONE, pending_power = NONE;
char transfer_id[17] = {};
uint32_t last_draw = 0, last_snapshot = 0, pressed_at = 0;
volatile int displayed_progress = -1;
volatile uint32_t progress_updates = 0;
bool button_down = false, held = false;
char notice[80] = {};
volatile int detents = 0;
volatile uint8_t last_encoder = 0;
volatile int quarter_steps = 0;
portMUX_TYPE encoder_mux = portMUX_INITIALIZER_UNLOCKED;
DRAM_ATTR const int8_t transitions[16] = {0, -1, 1, 0, 1, 0, 0, -1, -1, 0, 0, 1, 0, 1, -1, 0};
constexpr uint16_t background = 0x10c3, card = 0x2125, text = 0xeefc, muted = 0x8c91, accent = 0xfde0;

void IRAM_ATTR encoder_interrupt() {
  uint8_t state = (digitalRead(4) << 1) | digitalRead(5);
  portENTER_CRITICAL_ISR(&encoder_mux);
  quarter_steps += transitions[(last_encoder << 2) | state];
  last_encoder = state;
  if (quarter_steps >= 2) { ++detents; quarter_steps = 0; }
  if (quarter_steps <= -2) { --detents; quarter_steps = 0; }
  portEXIT_CRITICAL_ISR(&encoder_mux);
}
void navigate(Page target) { page = target; selection = 0; dirty = true; }
void back() {
  if (page == POWER_CONFIRM) navigate(POWER);
  else if (page == CONFIRM || page == RESULT) navigate(SCREENS);
  else if (page == SCREENS) navigate(DEVICES);
  else navigate(HOME);
}
int item_count() {
  if (page == HOME) return 5;
  if (page == POWER) return 3;
  if (page == DEVICES) return menu.device_count;
  if (page == SCREENS) return menu.preset_count;
  return 1;
}
void select() {
  if (page == HOME) {
    const Page pages[] = {DEVICES, SCREENS, ACTIVITY, NETWORK, POWER};
    navigate(pages[selection]);
  } else if (page == POWER) {
    power_action = selection == 0 ? SHUTDOWN : selection == 1 ? REBOOT : SCREEN_OFF;
    if (power_action == SCREEN_OFF) pending_power = SCREEN_OFF;
    else navigate(POWER_CONFIRM);
  } else if (page == POWER_CONFIRM) {
    pending_power = power_action;
  } else if (page == DEVICES && menu.device_count) {
    device_index = selection; navigate(SCREENS);
  } else if (page == SCREENS && menu.preset_count && menu.device_count) {
    preset_index = selection; navigate(CONFIRM);
  } else if (page == CONFIRM) {
    String id, error;
    if (studio_send(menu.serials[device_index], menu.preset_ids[preset_index], id, error)) navigate(ACTIVITY);
    else { strlcpy(notice, error.c_str(), sizeof(notice)); navigate(RESULT); }
  } else back();
}
String shorten(const String &value, int max_width) {
  String out = value;
  while (out.length() && lcd.textWidth(out + "...", 2) > max_width) out.remove(out.length() - 1);
  return out == value ? out : out + "...";
}
void line(const String &label, int y, bool selected, const String &suffix = "") {
  lcd.fillRoundRect(10, y, 300, 27, 6, selected ? accent : card);
  lcd.setTextColor(selected ? background : text, selected ? accent : card);
  lcd.drawString(shorten(label, suffix.length() ? 220 : 275), 20, y + 5, 2);
  if (suffix.length()) lcd.drawRightString(suffix, 298, y + 5, 2);
}
void draw_progress() {
  // Only these small regions change between bursts. Never repaint the whole
  // display or touch SPI while ModeTrans is servicing its FIFO.
  digitalWrite(12, HIGH); digitalWrite(13, HIGH); digitalWrite(44, HIGH);
  lcd.fillRoundRect(12, 69, 296, 27, 0, background);
  lcd.setTextColor(muted, background);
  lcd.drawString(transfer_screen && strcmp(menu.job_state, "queued") == 0 ? "Waking display..." :
    transfer_screen ? "Sending screen..." : String(menu.job_state), 14, 72, 2);
  lcd.fillRoundRect(14, 108, 292, 10, 5, card);
  if (menu.progress) lcd.fillRoundRect(14, 108, max(10, 292 * menu.progress / 100), 10, 5, accent);
  lcd.fillRoundRect(245, 121, 63, 20, 0, background);
  lcd.drawRightString(String(menu.progress) + "%", 306, 124, 2);
  displayed_progress = menu.progress;
  ++progress_updates;
  last_draw = millis();
  studio_discard_radio_edges();
}
void draw() {
  digitalWrite(12, HIGH); digitalWrite(13, HIGH); digitalWrite(44, HIGH);
  digitalWrite(43, LOW);
  lcd.startWrite();
  lcd.fillScreen(background);
  lcd.setTextColor(accent, background);
  lcd.drawString("CHROMA", 12, 7, 2);
  lcd.setTextColor(muted, background);
  lcd.drawRightString("STUDIO", 308, 7, 2);
  lcd.drawFastHLine(12, 30, 296, card);
  lcd.setTextColor(text, background);
  if (page == HOME) {
    const char *items[] = {"Displays", "Saved screens", "Activity", "Connection", "Power"};
    for (int row = 0; row < 3; ++row) {
      int index = max(0, selection - 2) + row;
      if (index < 5) line(items[index], 39 + row * 32, selection == index,
        index == 0 ? String(menu.device_count) : index == 1 ? String(menu.preset_count) : "");
    }
  } else if (page == DEVICES || page == SCREENS) {
    int count = item_count();
    if (!count) {
      lcd.drawString(page == DEVICES ? "Add displays in web app" : "Your library is empty", 14, 58, 2);
      lcd.setTextColor(muted, background); lcd.drawString("Save screens in web app", 14, 86, 2);
    }
    for (int row = 0; row < 3; ++row) {
      int index = max(0, selection - 2) + row;
      if (index < count) line(page == DEVICES ? menu.devices[index] : menu.presets[index], 39 + row * 32, index == selection);
    }
  } else if (page == CONFIRM) {
    lcd.drawString("Send to " + shorten(menu.devices[device_index], 180) + "?", 14, 43, 2);
    lcd.setTextColor(muted, background); lcd.drawString(shorten(menu.presets[preset_index], 285), 14, 75, 2);
    line("Press to send", 109, true);
  } else if (page == ACTIVITY) {
    lcd.drawString(menu.job[0] ? shorten(menu.job, 285) : "No transfers yet", 14, 43, 2);
    lcd.setTextColor(muted, background);
    draw_progress();
  } else if (page == POWER) {
    const char *items[] = {"Shutdown", "Reboot", "Turn off screen"};
    for (int row = 0; row < 3; ++row) line(items[row], 39 + row * 32, selection == row);
  } else if (page == POWER_CONFIRM) {
    lcd.drawString(power_action == SHUTDOWN ? "Shut down controller?" : "Reboot controller?", 14, 43, 2);
    lcd.setTextColor(muted, background);
    lcd.drawString(power_action == SHUTDOWN ? "Side button powers it on" : "Wi-Fi reconnects afterward", 14, 75, 2);
    line("Press to confirm", 109, true);
  } else if (page == NETWORK) {
    lcd.drawString(WiFi.status() == WL_CONNECTED ? "Connected to home Wi-Fi" : "Wi-Fi setup available", 14, 44, 2);
    lcd.setTextColor(accent, background);
    lcd.drawString(WiFi.status() == WL_CONNECTED ? WiFi.localIP().toString() : "192.168.4.1/wifi", 14, 74, 2);
    lcd.setTextColor(muted, background); lcd.drawString("USB setup is also available", 14, 105, 2);
  } else {
    lcd.drawString(shorten(notice, 285), 14, 65, 2);
    lcd.setTextColor(muted, background); lcd.drawString("Press to return", 14, 100, 2);
  }
  lcd.setTextColor(muted, background);
  lcd.drawFastHLine(12, 149, 296, card);
  lcd.drawString(transfer_screen ? "Sending... Controls resume when finished" : "Turn: browse   Press: select   Hold: back", 12, 153, 1);
  lcd.endWrite();
  studio_discard_radio_edges();
  dirty = false; last_draw = millis();
}
}

bool local_ui_prepare_transfer(const char *id, const char *title) {
  if (studio_radio_service()) return true;
  if (transfer_screen && strcmp(transfer_id, id) == 0) return true;
  uint32_t elapsed = millis() - get_last_slot_time();
  if (elapsed < 100 || elapsed > 850) return false;
  transfer_screen = true;
  strlcpy(transfer_id, id, sizeof(transfer_id));
  strlcpy(menu.job, title, sizeof(menu.job));
  strlcpy(menu.job_state, "queued", sizeof(menu.job_state));
  menu.progress = 0;
  page = ACTIVITY;
  if (!panel_sleeping && redraw_enabled) draw();
  detachInterrupt(4); detachInterrupt(5);
  portENTER_CRITICAL(&encoder_mux);
  detents = 0; quarter_steps = 0;
  portEXIT_CRITICAL(&encoder_mux);
  return true;
}

int local_ui_transfer_progress() {
  return !panel_sleeping && backlight_requested ? displayed_progress : -1;
}
uint32_t local_ui_progress_updates() { return progress_updates; }

void local_ui_finish_transfer(const char *id) {
  if (strcmp(transfer_id, id) != 0) return;
  transfer_screen = false; transfer_id[0] = 0; dirty = true;
  if (encoder_requested && !studio_radio_service()) {
    last_encoder = (digitalRead(4) << 1) | digitalRead(5);
    attachInterrupt(4, encoder_interrupt, CHANGE);
    attachInterrupt(5, encoder_interrupt, CHANGE);
  }
}

void local_ui_diagnostics(bool backlight, bool encoder, bool redraw) {
  if (studio_radio_service()) return;
  backlight_requested = backlight; encoder_requested = encoder;
  digitalWrite(21, backlight && !panel_sleeping ? HIGH : LOW);
  detachInterrupt(4); detachInterrupt(5);
  if (encoder && !transfer_screen) { attachInterrupt(4, encoder_interrupt, CHANGE); attachInterrupt(5, encoder_interrupt, CHANGE); }
  redraw_enabled = redraw;
  dirty = true;
}

void init_local_ui() {
  // GPIO6 is an RTC wake pin after shutdown; restore it to normal GPIO mode.
  rtc_gpio_deinit(GPIO_NUM_6);
  pinMode(0, INPUT_PULLUP); pinMode(6, INPUT_PULLUP);
  pinMode(4, INPUT_PULLUP); pinMode(5, INPUT_PULLUP);
  last_encoder = (digitalRead(4) << 1) | digitalRead(5);
  attachInterrupt(digitalPinToInterrupt(4), encoder_interrupt, CHANGE);
  attachInterrupt(digitalPinToInterrupt(5), encoder_interrupt, CHANGE);
  lcd.init(); lcd.setRotation(3); lcd.setTextWrap(false);
  pinMode(21, OUTPUT); digitalWrite(21, HIGH);
  studio_menu(menu);
  draw();
  Serial.println("Studio LCD ready: 320x170; wheel GPIO4/5, press GPIO0, home GPIO6");
}

void poll_local_ui(bool radio_idle) {
  if (studio_radio_service()) return;
  if (transfer_screen) {
    // Called only outside ModeTrans. Bursts normally yield after 850 ms;
    // finish these small redraws at least 100 ms before the next 1100 ms slot.
    // Manual screen-off stays respected during transfers.
    uint32_t elapsed = millis() - get_last_slot_time();
    if (!radio_idle || elapsed < 120 || elapsed > 1000 || millis() - last_snapshot < 500) return;
    studio_menu(menu);
    last_snapshot = millis();
    if (!panel_sleeping && redraw_enabled) draw_progress();
    return;
  }
  static uint32_t last_poll = 0;
  if (millis() - last_poll < 10) return;
  last_poll = millis();
  int steps;
  portENTER_CRITICAL(&encoder_mux); steps = detents; detents = 0; portEXIT_CRITICAL(&encoder_mux);
  bool down = digitalRead(0) == LOW;
  bool home = digitalRead(6) == LOW;
  uint32_t slot_elapsed = millis() - get_last_slot_time();
  bool safe_slot = radio_idle && slot_elapsed > 100 && slot_elapsed < 650;
  if (pending_power != NONE && safe_slot) {
    PowerAction action = pending_power;
    pending_power = NONE;
    // Read the latest queue, including jobs accepted since opening the menu.
    studio_menu(menu);
    if (action != SCREEN_OFF && (menu.queued || strcmp(menu.job_state, "sending") == 0 || strcmp(menu.job_state, "queued") == 0)) {
      strlcpy(notice, "Finish transfers first", sizeof(notice)); navigate(RESULT);
    } else if (action == REBOOT) {
      ESP.restart();
    } else {
      digitalWrite(21, LOW);
      if (!panel_sleeping) lcd.sleep(true);
      panel_sleeping = true;
      if (action == SHUTDOWN) {
        detachInterrupt(4); detachInterrupt(5);
        WiFi.mode(WIFI_OFF);
        // Match the manufacturer's shutdown: disable the peripheral power rail
        // and sleep the ESP32. USB/charging circuitry can still draw power.
        digitalWrite(15, LOW);
        rtc_gpio_pullup_en(GPIO_NUM_6);
        rtc_gpio_pulldown_dis(GPIO_NUM_6);
        esp_sleep_enable_ext0_wakeup(GPIO_NUM_6, 0);
        esp_deep_sleep_start();
      }
      screen_off = true;
      wake_release = true;
    }
  }
  if (screen_off) {
    // Consume the selecting press and then the wake press, without activating
    // the highlighted menu item. Radio and web jobs continue while dark.
    if (wake_release) { if (!down && !home) wake_release = false; }
    else if ((down || home) && safe_slot) {
      screen_off = false; wake_release = true; button_down = false; held = false;
      if (home) navigate(HOME);
    }
    if (screen_off) return;
  }
  if (panel_sleeping) {
    uint32_t elapsed = millis() - get_last_slot_time();
    if (!radio_idle || elapsed < 100 || elapsed > 650) return;
    lcd.sleep(false);
    delay(120);
    panel_sleeping = false;
    digitalWrite(21, backlight_requested ? HIGH : LOW);
    last_encoder = (digitalRead(4) << 1) | digitalRead(5);
    quarter_steps = 0;
    if (encoder_requested) { attachInterrupt(4, encoder_interrupt, CHANGE); attachInterrupt(5, encoder_interrupt, CHANGE); }
    dirty = true;
  }
  if (wake_release) {
    button_down = false;
    if (!down && !home) wake_release = false;
    return;
  }
  if (steps && item_count() > 0) {
    selection = (selection + steps) % item_count();
    if (selection < 0) selection += item_count();
    dirty = true;
  }
  if (down && !button_down) { pressed_at = millis(); held = false; }
  if (down && !held && millis() - pressed_at > 700) { back(); held = true; }
  if (!down && button_down && !held && millis() - pressed_at > 35) select();
  button_down = down;
  static bool home_down = false;
  if (home && !home_down) navigate(HOME);
  home_down = home;
  if (millis() - last_snapshot > 500) {
    StudioMenu next;
    studio_menu(next);
    if (memcmp(&next, &menu, sizeof(menu)) != 0) { menu = next; dirty = true; }
    device_index = min(device_index, max(0, menu.device_count - 1));
    preset_index = min(preset_index, max(0, menu.preset_count - 1));
    selection = min(selection, max(0, item_count() - 1));
    if (page == NETWORK) dirty = true;
    last_snapshot = millis();
  }
  // One loop owns LCD and radio SPI. Redraw only in the idle portion of a slot.
  slot_elapsed = millis() - get_last_slot_time();
  if (redraw_enabled && dirty && radio_idle && millis() - last_draw > 150 && slot_elapsed > 100 && slot_elapsed < 850) draw();
}
#endif
