#pragma once
// Packet dumps are opt-in: character-at-a-time USB diagnostics can stall
// continuous radio bursts when the host stops consuming the serial port.
#if defined(CHROMA_T_EMBED_CC1101) && !defined(CHROMA_RADIO_TRACE)
#define RADIO_TRACE(...) ((void)0)
#else
#define RADIO_TRACE(...) __VA_ARGS__
#endif
