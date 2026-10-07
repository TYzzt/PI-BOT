#pragma once
#include <cstdint>
#include <cstring>
#include <algorithm>
inline uint32_t preview_now=0;
inline uint32_t millis(){return preview_now;}
template<class T>T constrain(T a,T low,T high){return std::clamp(a,low,high);}
struct PreviewSerial {void println(const char *s){fprintf(stderr,"%s\n",s);}};
inline PreviewSerial Serial;
