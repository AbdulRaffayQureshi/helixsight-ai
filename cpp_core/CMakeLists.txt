cmake_minimum_required(VERSION 3.20)
project(helixsight_core LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)
if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
  set(CMAKE_BUILD_TYPE Release CACHE STRING "Build type" FORCE)
endif()

option(HS_BUILD_PYTHON "Build the pybind11 module" ON)
option(HS_BUILD_TESTS  "Build the doctest suite (standalone, no Python needed)" OFF)
option(HS_SANITIZE     "Enable ASan + UBSan (GCC/Clang)" OFF)

add_library(hs_core STATIC
  src/encode.cpp src/gc.cpp src/kmer.cpp src/cgr.cpp src/thermo.cpp src/zdna.cpp)
target_include_directories(hs_core PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/include)
set_target_properties(hs_core PROPERTIES POSITION_INDEPENDENT_CODE ON)
target_compile_options(hs_core PRIVATE
  $<$<CXX_COMPILER_ID:GNU,Clang,AppleClang>:-Wall -Wextra -Wpedantic>
  $<$<CXX_COMPILER_ID:MSVC>:/W4 /permissive->)
if(HS_SANITIZE AND CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
  target_compile_options(hs_core PUBLIC -fsanitize=address,undefined -fno-omit-frame-pointer)
  target_link_options(hs_core PUBLIC -fsanitize=address,undefined)
endif()

if(HS_BUILD_PYTHON)
  find_package(Python 3.11 COMPONENTS Interpreter Development.Module REQUIRED)
  find_package(pybind11 CONFIG REQUIRED)
  pybind11_add_module(helixsight_core MODULE bindings/module.cpp)
  target_link_libraries(helixsight_core PRIVATE hs_core)
  install(TARGETS helixsight_core LIBRARY DESTINATION .)
endif()

if(HS_BUILD_TESTS)
  enable_testing()
  add_executable(hs_tests tests/test_core.cpp)
  target_include_directories(hs_tests PRIVATE third_party/doctest)
  target_link_libraries(hs_tests PRIVATE hs_core)
  add_test(NAME hs_tests COMMAND hs_tests)
endif()
