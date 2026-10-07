// Original procedural character. No downloaded Grok/xAI geometry or artwork.
#include "PetAnimation.h"
#include <Arduino.h>
#include <esp_heap_caps.h>
#include <cmath>

static constexpr int W = 420, H = 320;
static constexpr float PET_PI = 3.14159265358979323846f;
static constexpr uint32_t BACKGROUND = 0xF5F3EF;
static lv_obj_t *canvas;
static lv_color_t *canvas_pixels;
static PetState current = PetState::Idle;
static uint32_t entered;
static float gaze_x, gaze_y;
static uint32_t gaze_until;
static const char *names[] = {"idle", "thinking", "working", "searching", "waiting", "success", "error", "sleeping"};

const char *pet_state_name(PetState state) { return names[static_cast<unsigned>(state)]; }
bool pet_parse_state(const char *name, PetState &state) {
  for (unsigned i = 0; i < PET_STATE_COUNT; ++i) {
    if (strcmp(name, names[i]) == 0) { state = static_cast<PetState>(i); return true; }
  }
  return false;
}

static void rect(float x, float y, float w, float h, uint32_t color, int radius, uint8_t opacity = 255) {
  lv_draw_rect_dsc_t d;
  lv_draw_rect_dsc_init(&d);
  d.bg_color = lv_color_hex(color);
  d.bg_opa = opacity;
  d.radius = radius;
  lv_canvas_draw_rect(canvas, lroundf(x), lroundf(y), lroundf(w), lroundf(h), &d);
}
static void line(float x1, float y1, float x2, float y2, uint32_t color, int width = 5) {
  lv_point_t p[] = {{(lv_coord_t)lroundf(x1), (lv_coord_t)lroundf(y1)}, {(lv_coord_t)lroundf(x2), (lv_coord_t)lroundf(y2)}};
  lv_draw_line_dsc_t d;
  lv_draw_line_dsc_init(&d);
  d.color = lv_color_hex(color);
  d.width = width;
  d.round_start = d.round_end = 1;
  lv_canvas_draw_line(canvas, p, 2, &d);
}
static void dot(float x, float y, int size, uint32_t color) { rect(x-size/2, y-size/2, size, size, color, LV_RADIUS_CIRCLE); }
static float signed_power(float x, float power) { return copysignf(powf(fabsf(x), power), x); }

static void fill_body(const lv_point_t *points, unsigned count) {
#ifdef PET_PREVIEW
  lv_draw_rect_dsc_t body;
  lv_draw_rect_dsc_init(&body);
  body.bg_color=lv_color_hex(0x343840);
  lv_canvas_draw_polygon(canvas, points, count, &body);
#else
  // Rasterize directly: LVGL 8's polygon path exhausts its 16 drawing masks
  // with this smooth outline. Scanlines need no masks or temporary LVGL heap.
  int top=H-1,bottom=0;
  for(unsigned i=0;i<count;++i) {top=min(top,(int)points[i].y);bottom=max(bottom,(int)points[i].y);}
  top=max(0,top);bottom=min(H-1,bottom);
  for(int y=top;y<=bottom;++y) {
    float left=W,right=-1;
    const float scan=y+.5f;
    for(unsigned i=0;i<count;++i) {
      const lv_point_t &a=points[i],&b=points[(i+1)%count];
      if((a.y<=scan && b.y>scan)||(b.y<=scan && a.y>scan)) {
        float x=a.x+(scan-a.y)*(b.x-a.x)/(b.y-a.y);
        left=fminf(left,x);right=fmaxf(right,x);
      }
    }
    if(right<left)continue;
    lv_color_t color=lv_color_mix(lv_color_hex(0x343840),lv_color_hex(0x424750),
      (lv_opa_t)(100+155*(y-top)/max(1,bottom-top)));
    int start=max(0,(int)ceilf(left)),end=min(W-1,(int)floorf(right));
    lv_color_t *row=canvas_pixels+y*W;
    for(int x=start;x<end;++x) row[x]=color;
    int edge=(int)floorf(left);
    if(edge>=0 && edge<W) row[edge]=lv_color_mix(color,row[edge],(lv_opa_t)((1-(left-edge))*255));
    edge=(int)floorf(right);
    if(edge>=0 && edge<W) row[edge]=lv_color_mix(color,row[edge],(lv_opa_t)((right-edge)*255));
  }
#endif
}

void pet_init(lv_obj_t *parent) {
  void *pixels = heap_caps_malloc(W * H * sizeof(lv_color_t), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  if (!pixels) { Serial.println("PET ERROR canvas allocation"); abort(); }
  canvas_pixels=static_cast<lv_color_t *>(pixels);
  canvas = lv_canvas_create(parent);
  lv_canvas_set_buffer(canvas, pixels, W, H, LV_IMG_CF_TRUE_COLOR);
  lv_obj_set_pos(canvas, 30, 64);
  lv_obj_add_flag(canvas, LV_OBJ_FLAG_CLICKABLE);
  lv_obj_set_style_bg_opa(canvas, LV_OPA_TRANSP, 0);
}
void pet_set_state(PetState state) { if (state != current) { current = state; entered = millis(); } }
void pet_gaze(int x, int y) {
  gaze_x = constrain((x - 240) / 16.0f, -10.0f, 10.0f);
  gaze_y = constrain((y - 215) / 18.0f, -7.0f, 7.0f);
  gaze_until = millis() + 1200;
}

void pet_draw(uint32_t now) {
  const float t = (now - entered) / 1000.0f;
  const float breath = sinf(t * 2.4f);
  float cx = 210, cy = 165 + 3 * breath, sx = 1 + .018f * breath, sy = 1 - .018f * breath;
  float tilt = .025f * sinf(t * 1.8f), eyes_h = 38, gx = 0, gy = 0;
  uint32_t accent = 0x60B9A0;
  const bool blink = (now % 4300 < 130);
  switch (current) {
    case PetState::Thinking: tilt = -.12f + .025f*sinf(t*2); gx = 7; gy = -6; accent=0xAD94D8; break;
    case PetState::Working: cy += 4*sinf(t*13); tilt=.045f*sinf(t*9); eyes_h=28; accent=0x63AABF; break;
    case PetState::Searching: gx=14*sinf(t*2.8f); tilt=.07f*sinf(t*2.8f); accent=0xE2AC64; break;
    case PetState::Waiting: tilt=.035f*sinf(t*1.4f); eyes_h=25; accent=0xD6A770; break;
    case PetState::Success: cy-=28*fabsf(sinf(t*4)); sx=1+.05f*sinf(t*8); sy=1-.04f*sinf(t*8); accent=0x60B9A0; break;
    case PetState::Error: cx+=5*sinf(t*18)*expf(-t*.5f); tilt=.07f*sinf(t*5); accent=0xD57F87; break;
    case PetState::Sleeping: cy+=15; sx=1.05f; sy=.84f; tilt=.04f; accent=0xA8ACB4; break;
    default: gx=4*sinf(t*.7f); break;
  }
  if ((int32_t)(gaze_until - now) > 0) { gx = gaze_x; gy = gaze_y; }
#ifdef PET_PREVIEW
  lv_canvas_fill_bg(canvas, lv_color_hex(BACKGROUND), LV_OPA_COVER);
#else
  // lv_canvas_fill_bg sets pixels through the generic image accessor. A flat
  // RGB565 canvas can instead be cleared with sequential PSRAM writes.
  const uint32_t pixel=lv_color_hex(BACKGROUND).full;
  uint32_t *pairs=reinterpret_cast<uint32_t *>(canvas_pixels);
  const uint32_t pair=pixel | (pixel<<16);
  for(unsigned i=0;i<W*H/2;++i) pairs[i]=pair;
  lv_obj_invalidate(canvas);
#endif
  rect(120, 273, 180, 15, 0xDAD8D3, LV_RADIUS_CIRCLE);

  // Feet and freely moving hands, behind the rounded body.
  rect(cx-65, cy+86*sy, 44, 24, 0x343840, LV_RADIUS_CIRCLE);
  rect(cx+21, cy+86*sy, 44, 24, 0x343840, LV_RADIUS_CIRCLE);
  float left_y=cy+20, right_y=cy+23;
  if (current==PetState::Success) { left_y=cy-65+8*sinf(t*9); right_y=cy-65-8*sinf(t*9); }
  if (current==PetState::Thinking) right_y=cy-25;
  if (current==PetState::Working) { left_y=cy+57+8*sinf(t*15); right_y=cy+57-8*sinf(t*15); }
  dot(cx-116*sx, left_y, 32, 0x424750);
  dot(cx+116*sx, right_y, 32, 0x424750);

  // A convex superellipse gives a soft, gently changing silhouette.
  lv_point_t outline[48];
  for (int i=0; i<48; ++i) {
    float a=i*2*PET_PI/48;
    float x=102*sx*signed_power(cosf(a), .73f);
    float y=93*sy*signed_power(sinf(a), .73f);
    outline[i]={(lv_coord_t)lroundf(cx+x*cosf(tilt)-y*sinf(tilt)), (lv_coord_t)lroundf(cy+x*sinf(tilt)+y*cosf(tilt))};
  }
  fill_body(outline,48);
  rect(cx-52, cy-68*sy, 70, 6, 0x555A64, LV_RADIUS_CIRCLE, 130);

  const float ex=cx+gx, ey=cy-8+gy;
  for (int eye=-1; eye<=1; eye+=2) {
    const float x=ex+eye*36, y=ey+eye*36*tilt;
    if (current==PetState::Sleeping || blink) {
      line(x-12,y,x+12,y,0xF5F3EF,5);
    } else if (current==PetState::Success) {
      line(x-13,y+4,x,y-9,0xF5F3EF,6);
      line(x,y-9,x+13,y+4,0xF5F3EF,6);
    } else if (current==PetState::Error) {
      line(x-10,y-10,x+10,y+10,0xF5F3EF,6);
      line(x+10,y-10,x-10,y+10,0xF5F3EF,6);
    } else {
      rect(x-12,y-eyes_h/2,24,eyes_h,0xF5F3EF,LV_RADIUS_CIRCLE);
      if(current==PetState::Thinking && eye==1) line(x-13,y-30,x+15,y-35,0xF5F3EF,4);
    }
  }
  if(current==PetState::Success) {
    line(cx-13,cy+35,cx,cy+42,0xF5F3EF,4);
    line(cx,cy+42,cx+13,cy+35,0xF5F3EF,4);
  } else if(current==PetState::Waiting) dot(cx,cy+37,7,0xF5F3EF);
  rect(cx-16,cy+62*sy,32,5,accent,LV_RADIUS_CIRCLE);

  if(current==PetState::Thinking) {
    for(int i=0;i<3;++i) dot(290+i*24,65-8*sinf(t*3-i*.8f),8+i*2,accent);
  } else if(current==PetState::Working) {
    rect(142,250,136,25,0xCBCFD2,7);
    for(int i=0;i<6;++i) rect(152+i*20,257,12,6,(int(t*7)%6==i)?accent:0xF5F3EF,2);
  } else if(current==PetState::Searching) {
    const float x=325+6*sinf(t*2.8f), y=180;
    // Lens ring drawn as a circle and a background inset.
    dot(x,y,48,accent); dot(x,y,36,BACKGROUND);
    line(x+17,y+17,x+35,y+35,accent,7);
  } else if(current==PetState::Waiting) {
    for(int i=0;i<3;++i) dot(185+i*25,303,8,accent);
  } else if(current==PetState::Success) {
    for(int i=0;i<10;++i) {
      float a=i*2*PET_PI/10+t*.3f, r=128+12*sinf(t*3+i);
      dot(cx+r*cosf(a),cy+r*.8f*sinf(a),6+i%3, i%2?accent:0xE2AC64);
    }
  } else if(current==PetState::Error) {
    line(325,72,325,94,accent,6); dot(325,107,7,accent);
  } else if(current==PetState::Sleeping) {
    for(int i=0;i<3;++i) {
      float x=290+i*22,y=95-i*25-6*sinf(t*1.5f+i);
      line(x,y,x+13,y,accent,3);line(x+13,y,x,y+13,accent,3);line(x,y+13,x+13,y+13,accent,3);
    }
  }
}
