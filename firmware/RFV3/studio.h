#pragma once
#ifdef CHROMA_T_EMBED_CC1101
#include <Arduino.h>
class AsyncWebServer;
struct StudioMenu {
  int device_count;
  char serials[12][12];
  char devices[12][41];
  int preset_count;
  char preset_ids[20][33];
  char presets[20][41];
  char job[49];
  char job_state[17];
  int progress;
  int queued;
  int brightness, screen_timeout;
  char error[97];
  int playlist_count;
  char playlist_ids[12][33], playlists[12][41];
  bool playlist_enabled[12];
};
void init_studio();
void poll_studio();
void studio_radio_mode(const String &mode);
void register_studio_routes(AsyncWebServer &server);
void studio_menu(StudioMenu &menu);
bool studio_send(const String &serial, const String &preset, String &id, String &error);
void init_local_ui();
void poll_local_ui(bool radio_idle);
void local_ui_diagnostics(bool backlight, bool encoder, bool redraw);
bool local_ui_prepare_transfer(const char *id, const char *title);
void local_ui_finish_transfer(const char *id);
int local_ui_transfer_progress();
uint32_t local_ui_progress_updates();
void studio_discard_radio_edges();
uint32_t studio_discarded_radio_edges();
bool studio_radio_service();
bool studio_playlist_toggle(const char *id, String &error);
#endif
