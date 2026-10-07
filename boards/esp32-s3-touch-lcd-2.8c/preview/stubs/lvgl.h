#pragma once
#include <cstdint>
#include <cstdlib>
#include <cstdio>
#include <sstream>
#include <iomanip>
#include <string>
using lv_coord_t=int16_t;
using lv_color_t=uint32_t;
struct lv_obj_t {};
struct lv_point_t {lv_coord_t x,y;};
struct lv_draw_rect_dsc_t {uint32_t bg_color=0;int bg_opa=255,radius=0;};
struct lv_draw_line_dsc_t {uint32_t color=0;int width=1,round_start=0,round_end=0;};
constexpr int LV_RADIUS_CIRCLE=32767,LV_IMG_CF_TRUE_COLOR=1,LV_OBJ_FLAG_CLICKABLE=1,LV_OPA_TRANSP=0,LV_OPA_COVER=255;
inline std::ostringstream svg;
inline std::string hexcolor(uint32_t n) {std::ostringstream s;s<<'#'<<std::hex<<std::setfill('0')<<std::setw(6)<<n;return s.str();}
inline lv_color_t lv_color_hex(uint32_t n){return n;}
inline lv_obj_t *lv_canvas_create(lv_obj_t *){static lv_obj_t c;return &c;}
inline void lv_canvas_set_buffer(lv_obj_t *,void *,int,int,int){}
inline void lv_obj_set_pos(lv_obj_t *,int,int){}
inline void lv_obj_add_flag(lv_obj_t *,int){}
inline void lv_obj_set_style_bg_opa(lv_obj_t *,int,int){}
inline void lv_canvas_fill_bg(lv_obj_t *,lv_color_t,int){svg.str("");svg.clear();}
inline void lv_draw_rect_dsc_init(lv_draw_rect_dsc_t *d){*d={};}
inline void lv_draw_line_dsc_init(lv_draw_line_dsc_t *d){*d={};}
inline void lv_canvas_draw_rect(lv_obj_t *,int x,int y,int w,int h,lv_draw_rect_dsc_t *d){
 int r=d->radius;if(r==LV_RADIUS_CIRCLE)r=std::min(w,h)/2;
 svg<<"<rect x='"<<x<<"' y='"<<y<<"' width='"<<w<<"' height='"<<h<<"' rx='"<<r<<"' fill='"<<hexcolor(d->bg_color)<<"' opacity='"<<d->bg_opa/255.0<<"'/>";
}
inline void lv_canvas_draw_line(lv_obj_t *,const lv_point_t *p,int,lv_draw_line_dsc_t *d){
 svg<<"<line x1='"<<p[0].x<<"' y1='"<<p[0].y<<"' x2='"<<p[1].x<<"' y2='"<<p[1].y<<"' stroke='"<<hexcolor(d->color)<<"' stroke-width='"<<d->width<<"' stroke-linecap='round'/>";
}
inline void lv_canvas_draw_polygon(lv_obj_t *,const lv_point_t *p,int n,lv_draw_rect_dsc_t *d){
 svg<<"<polygon fill='"<<hexcolor(d->bg_color)<<"' points='";for(int i=0;i<n;++i)svg<<p[i].x<<","<<p[i].y<<" ";svg<<"'/>";
}
