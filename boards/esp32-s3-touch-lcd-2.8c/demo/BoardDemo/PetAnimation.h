#pragma once
#include <lvgl.h>

enum class PetState : uint8_t { Idle, Thinking, Working, Searching, Waiting, Success, Error, Sleeping };
constexpr unsigned PET_STATE_COUNT = 8;
const char *pet_state_name(PetState state);
bool pet_parse_state(const char *name, PetState &state);
void pet_init(lv_obj_t *parent);
void pet_set_state(PetState state);
void pet_draw(uint32_t now);
void pet_gaze(int x, int y);
