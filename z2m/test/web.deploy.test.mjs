import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";

const script = readFileSync(new URL("../../scripts/deploy-web.sh", import.meta.url), "utf8");

test("web deploy normalizes static Caddy-readable permissions", () => {
  assert.match(script, /rsync\s+-a\s+--delete/);
  assert.match(script, /--chmod=Du=rwx,Dgo=rx,Fu=rw,Fgo=r/);
  assert.match(script, /\/var\/www\/c6-enviro\//);
});
