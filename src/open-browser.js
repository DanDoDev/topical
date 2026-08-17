import { spawn } from "node:child_process";
import process from "node:process";

export function browserLaunchCommand(address, platform = process.platform) {
  if (platform === "darwin") return { command: "open", args: [address] };
  if (platform === "win32") return { command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", address] };
  return { command: "xdg-open", args: [address] };
}

export function openBrowser(address, { platform = process.platform, spawnProcess = spawn } = {}) {
  const url = new URL(address);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") {
    throw new Error("Topical only opens its loopback HTTP UI.");
  }

  const { command, args } = browserLaunchCommand(url.href, platform);
  return new Promise((resolve, reject) => {
    const child = spawnProcess(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
