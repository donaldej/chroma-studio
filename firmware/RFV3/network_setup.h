#pragma once

#ifdef CHROMA_T_EMBED_CC1101
class AsyncWebServer;
void init_network();
void poll_network();
void register_network_routes(AsyncWebServer &server);
#endif
