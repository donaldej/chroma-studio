#include <Arduino.h>
#include <SPI.h>
#include "RFV3.h"
#include "cc1101_spi.h"

SPIClass * vspi = NULL;

void init_spi() {
  log("SPI init"); 
#ifdef CHROMA_T_EMBED_CC1101
  // LCD, SD and nRF24 share the radio SPI bus: deselect them before power-up.
  const uint8_t chip_selects[] = {41, 13, 44, SS_PIN};
  for (uint8_t pin : chip_selects) {
    digitalWrite(pin, HIGH);
    pinMode(pin, OUTPUT);
  }
  digitalWrite(43, LOW); // nRF24 CE: keep the unused radio disabled.
  pinMode(43, OUTPUT);
  digitalWrite(21, LOW); // LCD backlight off; this port uses the browser UI.
  pinMode(21, OUTPUT);
  digitalWrite(47, LOW); // RF switch SW1=0, SW0=1: 868/915 MHz path.
  pinMode(47, OUTPUT);
  digitalWrite(48, HIGH);
  pinMode(48, OUTPUT);
  digitalWrite(15, HIGH); // Enable board peripherals, including CC1101.
  pinMode(15, OUTPUT);
  delay(100);
#endif
  pinMode(SS_PIN, OUTPUT);
#if CONFIG_IDF_TARGET_ESP32S3
  vspi = new SPIClass(HSPI);
#else
  vspi = new SPIClass(VSPI);
#endif
  digitalWrite(SS_PIN, HIGH);
  vspi->begin(CLK_PIN,MISO_PIN,MOSI_PIN);
  log("SPI init done"); 
}

void spi_start() {
#ifdef CHROMA_T_EMBED_CC1101
  // Match LILYGO's shared-bus handoff before every radio transaction.
  digitalWrite(41, HIGH);
  digitalWrite(13, HIGH);
  digitalWrite(44, HIGH);
  digitalWrite(43, LOW);
#endif
  vspi->beginTransaction(SPISettings(4000000, MSBFIRST, SPI_MODE0));
  // Configure clock polarity before selecting CC1101: the LCD uses mode 3.
  digitalWrite(SS_PIN, LOW);
}

void spi_end() {
  digitalWrite(SS_PIN, HIGH);
  vspi->endTransaction();
}

uint8_t spi_putc(uint8_t data) {
  return vspi->transfer(data);
}

void spi_write_strobe(uint8_t spi_instr)
{
  spi_start();
  spi_putc(spi_instr);
  spi_end();
}

uint8_t spi_read_register(uint8_t spi_instr)
{
  spi_start();
  spi_putc(spi_instr | 0x80);
  spi_instr = spi_putc(0xFF);
  spi_end();

  return spi_instr;
}

void spi_read_burst(uint8_t spi_instr, uint8_t *pArr, uint8_t length)
{
  spi_start();
  spi_putc(spi_instr | 0xC0);

  for (uint8_t i = 0; i < length; i++)
  {
    pArr[i] = spi_putc(0xFF);
  }
  spi_end();
}

void spi_write_register(uint8_t spi_instr, uint8_t value)
{
  spi_start();
  spi_putc(spi_instr | 0x00);
  spi_putc(value);
  spi_end();
}

void spi_write_burst(uint8_t spi_instr, uint8_t *pArr, uint8_t length)
{
  spi_start();
  spi_putc(spi_instr | 0x40);

  for (uint8_t i = 0; i < length ; i++)
  {
    spi_putc(pArr[i]);
  }
  spi_end();
}
