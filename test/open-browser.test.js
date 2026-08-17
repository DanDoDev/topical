import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { browserLaunchCommand, openBrowser } from "../src/open-browser.js";

test("browser launching uses platform tools without a shell", () => {
  const address = "http://127.0.0.1:2223/";
  assert.deepEqual(browserLaunchCommand(address, "darwin"), { command: "open", args: [address] });
  assert.deepEqual(browserLaunchCommand(address, "win32"), {
    command: "rundll32.exe",
    args: ["url.dll,FileProtocolHandler", address]
  });
  assert.deepEqual(browserLaunchCommand(address, "linux"), { command: "xdg-open", args: [address] });
});

test("browser launching accepts only the loopback Topical UI", () => {
  assert.throws(() => openBrowser("https://example.com"), /only opens its loopback HTTP UI/);
  assert.throws(() => openBrowser("http://localhost:2223"), /only opens its loopback HTTP UI/);
});

test("browser launching detaches after the operating-system command starts", async () => {
  const child = new EventEmitter();
  let unrefCalled = false;
  child.unref = () => { unrefCalled = true; };
  const spawnProcess = (command, args, options) => {
    assert.equal(command, "xdg-open");
    assert.deepEqual(args, ["http://127.0.0.1:2223/"]);
    assert.deepEqual(options, { detached: true, stdio: "ignore", windowsHide: true });
    queueMicrotask(() => child.emit("spawn"));
    return child;
  };

  await openBrowser("http://127.0.0.1:2223", { platform: "linux", spawnProcess });
  assert.equal(unrefCalled, true);
});
