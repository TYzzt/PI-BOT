// Render the actual firmware character drawing calls to SVG for visual review.
#include "Arduino.h"
#include "PetAnimation.h"
#include <fstream>
#include <filesystem>
int main(int argc,char **argv){
 if(argc!=2)return 1;
 std::filesystem::create_directories(argv[1]);
 lv_obj_t root;pet_init(&root);
 for(unsigned i=0;i<PET_STATE_COUNT;++i){
  preview_now=0;pet_set_state(static_cast<PetState>(i));preview_now=1700;pet_draw(preview_now);
  std::ofstream out(std::string(argv[1])+"/"+pet_state_name(static_cast<PetState>(i))+".svg");
  out<<"<svg xmlns='http://www.w3.org/2000/svg' width='480' height='480' viewBox='0 0 480 480'><rect width='480' height='480' fill='#F5F3EF'/><text x='240' y='36' text-anchor='middle' font-family='sans-serif' font-size='20' fill='#343840'>Pi Bot buddy</text><g transform='translate(30 64)'>"<<svg.str()<<"</g><text x='240' y='410' text-anchor='middle' font-family='sans-serif' font-size='20' fill='#343840'>"<<pet_state_name(static_cast<PetState>(i))<<"</text></svg>";
 }
}
