import { expect, it, vi } from "vitest";
const updater = vi.hoisted(() => ({ listeners: new Map<string, (...args: any[]) => void>(), quitAndInstall: vi.fn() }));
vi.mock("electron", () => ({ app: { isPackaged: true } }));
vi.mock("electron-updater", () => ({ default: { autoUpdater: { on: (name: string, fn: (...args: any[]) => void) => updater.listeners.set(name, fn), quitAndInstall: updater.quitAndInstall } } }));
import { DesktopUpdater } from "../src/desktop/updater.js";

it("prepares and launches a downloaded update once despite repeated clicks", async () => {
  let finish!: () => void;
  const cleanup = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const desktop = new DesktopUpdater("1.0.0", cleanup);
  updater.listeners.get("update-downloaded")!({ version: "1.1.0" });
  const first = desktop.install();
  await desktop.install();
  expect(cleanup).toHaveBeenCalledOnce();
  expect(updater.quitAndInstall).not.toHaveBeenCalled();
  finish(); await first;
  await desktop.install();
  expect(cleanup).toHaveBeenCalledOnce();
  expect(updater.quitAndInstall).toHaveBeenCalledExactlyOnceWith(false, true);
});
