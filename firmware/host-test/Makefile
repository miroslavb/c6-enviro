# Host-compiled unit tests for the PURE firmware logic (firmware/main/cycle.c).
# No ESP-IDF, no toolchain — any host cc runs these. `make` builds + runs.
CC      ?= cc
CFLAGS  ?= -std=c11 -Wall -Wextra -Werror -O2 -I../main

all: run

test_cycle: test_cycle.c ../main/cycle.c ../main/cycle.h
	$(CC) $(CFLAGS) -o $@ test_cycle.c ../main/cycle.c

run: test_cycle
	./test_cycle

clean:
	rm -f test_cycle

.PHONY: all run clean
