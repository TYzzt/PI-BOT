#include <Arduino.h>
#include "LVGL_Driver.h"

static lv_obj_t *status_label;
static lv_obj_t *counter_label;
static unsigned taps = 0;

static void on_tap(lv_event_t *event) {
  lv_label_set_text_fmt(counter_label, "Touch count: %u", ++taps);
  Serial.printf("DEMO touch count=%u\n", taps);
}

static void on_brightness(lv_event_t *event) {
  Set_Backlight(lv_slider_get_value(lv_event_get_target(event)));
}

static void update_status(lv_timer_t *timer) {
  lv_label_set_text_fmt(status_label, "Uptime: %lus\nFree heap: %lu KB\nPSRAM: %lu MB",
    (unsigned long)(millis() / 1000), (unsigned long)(ESP.getFreeHeap() / 1024),
    (unsigned long)(ESP.getPsramSize() / 1024 / 1024));
  Serial.printf("DEMO alive uptime=%lu heap=%lu psram=%lu\n",
    (unsigned long)(millis() / 1000), (unsigned long)ESP.getFreeHeap(),
    (unsigned long)ESP.getPsramSize());
}

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("Pi Bot BoardDemo boot");
  I2C_Init();
  delay(120);
  Wire.beginTransmission(TCA9554_ADDRESS);
  if (Wire.endTransmission() != 0) {
    Serial.println("DEMO ERROR: TCA9554 I2C not responding");
    while (true) delay(1000);
  }
  TCA9554PWR_Init(0x00);
  Set_EXIO(EXIO_PIN8, Low);
  LCD_Init();
  Wire.beginTransmission(GT911_ADDR);
  Serial.printf("DEMO GT911 I2C: %s\n", Wire.endTransmission() == 0 ? "OK" : "FAILED");
  Set_Backlight(65);
  Lvgl_Init();
  lv_obj_t *screen = lv_scr_act();
  lv_obj_clean(screen);
  lv_obj_set_style_bg_color(screen, lv_color_hex(0x101827), 0);
  lv_obj_set_style_text_color(screen, lv_color_hex(0xE6EDF7), 0);

  lv_obj_t *title = lv_label_create(screen);
  lv_label_set_text(title, "Pi Bot | ESP32-S3");
  lv_obj_align(title, LV_ALIGN_TOP_MID, 0, 30);
  lv_obj_t *subtitle = lv_label_create(screen);
  lv_label_set_text(subtitle, "480 x 480  /  Touch demo");
  lv_obj_align(subtitle, LV_ALIGN_TOP_MID, 0, 68);

  status_label = lv_label_create(screen);
  lv_obj_align(status_label, LV_ALIGN_TOP_LEFT, 45, 110);
  counter_label = lv_label_create(screen);
  lv_label_set_text(counter_label, "Touch count: 0");
  lv_obj_align(counter_label, LV_ALIGN_TOP_MID, 0, 218);

  lv_obj_t *button = lv_btn_create(screen);
  lv_obj_set_size(button, 300, 62);
  lv_obj_align(button, LV_ALIGN_TOP_MID, 0, 260);
  lv_obj_add_event_cb(button, on_tap, LV_EVENT_CLICKED, nullptr);
  lv_obj_t *button_label = lv_label_create(button);
  lv_label_set_text(button_label, "Tap me");
  lv_obj_center(button_label);

  lv_obj_t *brightness_label = lv_label_create(screen);
  lv_label_set_text(brightness_label, "Backlight");
  lv_obj_align(brightness_label, LV_ALIGN_TOP_MID, 0, 352);
  lv_obj_t *slider = lv_slider_create(screen);
  lv_obj_set_size(slider, 330, 18);
  lv_obj_align(slider, LV_ALIGN_TOP_MID, 0, 395);
  lv_slider_set_range(slider, 10, 100);
  lv_slider_set_value(slider, 65, LV_ANIM_OFF);
  lv_obj_add_event_cb(slider, on_brightness, LV_EVENT_VALUE_CHANGED, nullptr);

  update_status(nullptr);
  lv_timer_create(update_status, 1000, nullptr);
  Serial.println("DEMO ready: LCD + GT911 touch + backlight");
}

void loop() {
  Lvgl_Loop();
  delay(5);
}
