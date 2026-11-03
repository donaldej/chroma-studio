#include <Arduino.h>
#include <SPI.h>
#include "RFV3.h"
#include "main_variables.h"
#include "cc1101_spi.h"
#include "cc1101.h"
#include "class.h"
#include "compression.h"
#include "interval_timer.h"
#include "settings.h"
#include "web.h"
#include "network_setup.h"
#include "studio.h"
#include "firmware_update.h"
#include "utils.h"
#include "mode_sync.h"
#include "mode_full_sync.h"
#include "mode_idle.h"
#include "mode_trans.h"
#include "mode_wu.h"
#include "mode_wu_reset.h"
#include "mode_wu_activation.h"
#include "mode_wun_activation.h"
#include "mode_activation.h"

class ModePlaceholder : public mode_class
{
};
ModePlaceholder modePlaceholder;

mode_class *currentMode = &modePlaceholder;
mode_class *tempMode = &modeIdle;

volatile int interrupt_counter = 0;
int no_count_counter = 0;

volatile int int_fired = 0;
#ifdef CHROMA_T_EMBED_CC1101
portMUX_TYPE radio_event_mux = portMUX_INITIALIZER_UNLOCKED;
uint32_t discarded_radio_edges = 0;
void studio_discard_radio_edges() {
  portENTER_CRITICAL(&radio_event_mux);
  discarded_radio_edges += int_fired;
  int_fired = 0;
  portEXIT_CRITICAL(&radio_event_mux);
}
uint32_t studio_discarded_radio_edges() { return discarded_radio_edges; }
#endif
void IRAM_ATTR GDO2_interrupt()
{
#ifdef CHROMA_T_EMBED_CC1101
  portENTER_CRITICAL_ISR(&radio_event_mux);
#endif
  interrupt_counter++;
  int_fired++;
#ifdef CHROMA_T_EMBED_CC1101
  portEXIT_CRITICAL_ISR(&radio_event_mux);
#endif
}

void init_interrupt()
{
  pinMode(GDO2, INPUT);
  attachInterrupt(GDO2, GDO2_interrupt, FALLING);
}

void log(String message)
{
#if !defined(CHROMA_T_EMBED_CC1101) || defined(CHROMA_RADIO_TRACE)
  Serial.print(millis());
  Serial.println(" : " + message);
#endif
}

void setup()
{
#ifdef CHROMA_T_EMBED_CC1101
  Serial.setRxBufferSize(2048);
  Serial.setTxBufferSize(8192);
  // Diagnostics must not stall radio timing when no computer is reading USB.
  Serial.setTxTimeoutMs(1);
#endif
  Serial.begin(500000);
  Serial.setDebugOutput(true);
  SPIFFS.begin(true);
  init_spi();
  uint8_t radio_status;
  while ((radio_status=init_radio()))
  {
    if (radio_status == 1)
      Serial.println("Radio not working!!! ERROR");
    if (radio_status == 2)
      Serial.println("GPIO2 Interrupt input not working");
    delay(1000);
  }
  read_boot_settings();
#ifdef CHROMA_T_EMBED_CC1101
  init_studio();
  if (!studio_radio_service()) init_local_ui();
#endif
  init_interrupt();
  init_timer();
  init_web();
}

void loop()
{
#ifdef CHROMA_T_EMBED_CC1101
  // A data transfer blocks OTA admission. Keep updater mutex/timeout work out
  // of the FIFO refill path, just like the existing Studio and LCD polling.
  if (currentMode != &modeTrans) {
    poll_firmware_update();
    if (studio_firmware_busy()) { studio_discard_radio_edges(); delay(2); return; }
  }
  poll_network();
#endif
#ifdef CHROMA_T_EMBED_CC1101
  portENTER_CRITICAL(&radio_event_mux);
  bool radio_event = int_fired > 0;
  if (radio_event) --int_fired;
  portEXIT_CRITICAL(&radio_event_mux);
  if (radio_event)
#else
  if (int_fired)
#endif
  {
#ifndef CHROMA_T_EMBED_CC1101
    int_fired--;
#endif
    currentMode->interrupt();
  }
  if (currentMode != tempMode)
  {
    currentMode->post();
    currentMode = tempMode;
#ifdef CHROMA_T_EMBED_CC1101
    studio_radio_mode(currentMode->get_name());
#endif
    log("Mode changed to " + currentMode->get_name());
    currentMode->pre();
  }
  currentMode->main();
  if (check_new_interval())
  {
    log("Count: " + String(interrupt_counter));
    if (interrupt_counter == 0)
    {
      if (no_count_counter++ > 5)
      {
        no_count_counter = 0;
        log("no interrupts anymore, something is broken, trying to fix it now");
        if (get_trans_mode())
        {
          set_trans_mode(0);
          restore_current_settings();
        }
        set_last_activation_status(0);
        if (currentMode == &modeIdle)
          set_mode_full_sync();
        else if (currentMode == &modeFullSync || currentMode == &modeWu || currentMode == &modeWuAct || currentMode == &modeWunAct || currentMode == &modeWuReset || currentMode == &modeActivation)
        {
          currentMode->pre();
        }
        else
          set_mode_idle();
      }
    }
    else
    {
      no_count_counter = 0;
    }
    interrupt_counter = 0;
    currentMode->new_interval();
  }
#ifdef CHROMA_T_EMBED_CC1101
  // Continuous FIFO refills must run without UI/model mutex work between
  // packets. Drain queued application work in idle gaps between radio slots.
  if (currentMode != &modeTrans) {
    poll_studio();
    poll_local_ui(currentMode == &modeIdle && tempMode == &modeIdle && int_fired == 0);
  }
#endif
}

void set_mode_idle()
{
  tempMode = &modeIdle;
}

void set_mode_sync()
{
  tempMode = &modeSync;
}

void set_mode_full_sync()
{
  tempMode = &modeFullSync;
}

void set_mode_trans()
{
  tempMode = &modeTrans;
}

void set_mode_wu()
{
  tempMode = &modeWu;
}

void set_mode_wu_reset()
{
  tempMode = &modeWuReset;
}

void set_mode_wu_activation()
{
  tempMode = &modeWuAct;
}

void set_mode_wun_activation()
{
  tempMode = &modeWunAct;
}

void set_mode_activation()
{
  tempMode = &modeActivation;
}

String get_mode_string()
{
  return currentMode->get_name();
}
