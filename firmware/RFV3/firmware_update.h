#pragma once
#ifdef CHROMA_T_EMBED_CC1101
#include <Arduino.h>
#define STUDIO_VERSION "0.5.0"
#define STUDIO_FIRMWARE_TARGET "CHROMA-STUDIO:T-EMBED-CC1101-PLUS:WEB1:"
class AsyncWebServer;
void register_firmware_routes(AsyncWebServer &server);
void poll_firmware_update();
bool studio_firmware_busy();
bool studio_begin_firmware_update(String &error);
void studio_end_firmware_update();
#endif
