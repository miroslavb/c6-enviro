# ESP32-C6 enviro sensor — ESP-IDF 5.4 project.
# Build reproducibly via scripts/build-firmware.sh (espressif/idf:release-v5.4 Docker).
cmake_minimum_required(VERSION 3.16)
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(c6_enviro)
