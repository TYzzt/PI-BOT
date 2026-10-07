#include <Arduino.h>
#include "LVGL_Driver.h"
#include "PetAnimation.h"

static lv_obj_t *state_label, *mode_label, *mode_button_label;
static PetState state = PetState::Idle;
static bool demo = true, host_seen = false;
static uint32_t last_state, last_host, frames, frame_us;
static char command[64];
static unsigned command_len;
static bool overflow;
static const char *captions[] = {"Ready when you are", "Thinking it through", "Making things happen", "Looking for clues", "Waiting for you", "Nicely done!", "Let's try again", "Taking a little nap"};

static void update_labels() {
  lv_label_set_text(state_label, captions[static_cast<unsigned>(state)]);
  lv_label_set_text(mode_label, demo ? "DEMO / tap to explore" : host_seen ? "LIVE / T-AGNET" : "LIVE / disconnected");
  lv_label_set_text(mode_button_label, demo ? "Go live" : "Demo");
}
static void set_state(PetState next, const char *source) {
  state = next;
  last_state = millis();
  pet_set_state(next);
  update_labels();
  Serial.printf("PET state=%s source=%s\n", pet_state_name(state), source);
}
static void on_next(lv_event_t *) { demo=true; set_state(static_cast<PetState>((static_cast<unsigned>(state)+1)%PET_STATE_COUNT), "touch"); }
static void on_mode(lv_event_t *) { demo=!demo; set_state(PetState::Idle,"touch"); }
static void on_gaze(lv_event_t *event) {
  lv_indev_t *input=lv_event_get_indev(event);
  if(input) { lv_point_t p; lv_indev_get_point(input,&p); pet_gaze(p.x,p.y); }
}
static void handle_command() {
  if(strcmp(command,"PING")==0) {
    last_host=millis();
    if(!host_seen) {host_seen=true;update_labels();}
    Serial.println("PET pong");
  } else if(strcmp(command,"DEMO")==0) {
    demo=true; set_state(PetState::Idle,"serial"); Serial.println("PET ack=demo");
  } else if(strncmp(command,"STATE ",6)==0) {
    PetState next;
    if(!pet_parse_state(command+6,next)) {Serial.println("PET error=unknown-state");return;}
    demo=false;host_seen=true;last_host=millis();set_state(next,"serial");
    Serial.printf("PET ack=%s\n",pet_state_name(next));
  } else if(strcmp(command,"STATUS")==0) {
    Serial.printf("PET status=%s mode=%s frames=%lu draw_us=%lu heap=%lu psram_free=%lu\n",pet_state_name(state),demo?"demo":"live",(unsigned long)frames,(unsigned long)frame_us,(unsigned long)ESP.getFreeHeap(),(unsigned long)ESP.getFreePsram());
  } else {Serial.println("PET error=unknown-command");}
}
static void read_commands() {
  // Bounded input work keeps a noisy host from starving the animation.
  for(unsigned n=0;n<128 && Serial.available();++n) {
    char c=Serial.read();
    if(c=='\r') continue;
    if(c=='\n') {
      if(overflow) Serial.println("PET error=command-too-long");
      else if(command_len) {command[command_len]=0;handle_command();}
      command_len=0;overflow=false;
    } else if(command_len<sizeof(command)-1 && !overflow) command[command_len++]=c;
    else overflow=true;
  }
}
static void animate(lv_timer_t *) {
  uint32_t now=millis();
  if(!demo && host_seen && now-last_host>12000) {host_seen=false;set_state(PetState::Waiting,"disconnect");}
  if(demo && now-last_state>6500) set_state(static_cast<PetState>((static_cast<unsigned>(state)+1)%PET_STATE_COUNT),"demo");
  const uint32_t started=micros();
  pet_draw(now);frame_us=micros()-started;++frames;
}
static lv_obj_t *button(lv_obj_t *screen, int x, const char *caption, lv_event_cb_t action) {
  lv_obj_t *b=lv_btn_create(screen);lv_obj_set_pos(b,x,423);lv_obj_set_size(b,180,42);
  lv_obj_set_style_bg_color(b,lv_color_hex(0xE5E3DF),0);
  lv_obj_set_style_shadow_width(b,0,0);
  lv_obj_set_style_radius(b,21,0);
  lv_obj_set_style_text_color(b,lv_color_hex(0x343840),0);
  lv_obj_add_event_cb(b,action,LV_EVENT_CLICKED,nullptr);
  lv_obj_t *label=lv_label_create(b);lv_label_set_text(label,caption);lv_obj_center(label);return label;
}
void setup() {
  Serial.begin(115200);delay(200);
  Serial.println("T-AGNET AgentPet boot");
  I2C_Init();delay(120);
  Wire.beginTransmission(TCA9554_ADDRESS);
  if(Wire.endTransmission()!=0) {Serial.println("PET ERROR TCA9554 missing");while(true) delay(1000);}
  TCA9554PWR_Init(0x00);Set_EXIO(EXIO_PIN8,Low);
  LCD_Init();Set_Backlight(65);
  Wire.beginTransmission(GT911_ADDR);
  Serial.printf("PET GT911=%s\n",Wire.endTransmission()==0?"OK":"FAILED");
  Lvgl_Init();
  lv_obj_t *screen=lv_scr_act();lv_obj_clean(screen);
  lv_obj_set_style_bg_color(screen,lv_color_hex(0xF5F3EF),0);
  lv_obj_set_style_text_color(screen,lv_color_hex(0x343840),0);
  lv_obj_t *title=lv_label_create(screen);lv_label_set_text(title,"T-AGNET buddy");lv_obj_align(title,LV_ALIGN_TOP_MID,0,18);
  mode_label=lv_label_create(screen);lv_obj_set_style_text_font(mode_label,&lv_font_montserrat_14,0);lv_obj_set_style_text_color(mode_label,lv_color_hex(0x82868B),0);lv_obj_align(mode_label,LV_ALIGN_TOP_MID,0,45);
  pet_init(screen);
  state_label=lv_label_create(screen);lv_obj_align(state_label,LV_ALIGN_TOP_MID,0,388);
  button(screen,45,"Next mood",on_next);
  mode_button_label=button(screen,255,"Go live",on_mode);
  lv_obj_add_event_cb(screen,on_gaze,LV_EVENT_PRESSING,nullptr);
  // Canvas events bubble so gaze follows touches on the character itself.
  lv_obj_t *canvas=lv_obj_get_child(screen,2);
  lv_obj_add_flag(canvas,LV_OBJ_FLAG_EVENT_BUBBLE);
  lv_obj_add_event_cb(canvas,on_next,LV_EVENT_CLICKED,nullptr);
  set_state(PetState::Idle,"boot");
  pet_draw(millis());lv_timer_create(animate,50,nullptr);
  Serial.println("PET ready states=8 protocol=1");
}
void loop() {
  read_commands();Lvgl_Loop();delay(5);
}
