import { expect, it, vi } from "vitest";
const updater = vi.hoisted(() => ({ listeners: new Map<string, (...args: any[]) => void>(), quitAndInstall: vi.fn() }));
vi.mock("electron", () => ({ app: { isPackaged: true } }));
vi.mock("electron-updater", () => ({ default: { autoUpdater: { on: (name: string, fn: (...args: any[]) => void) => updater.listeners.set(name, fn), quitAndInstall: updater.quitAndInstall } } }));
import { DesktopUpdater } from "../src/desktop/updater.js";

it("keeps a downloaded update ready when saving cancels installation, then allows retry", async () => {
  const save = vi.fn().mockRejectedValueOnce(new Error("Unsaved conflict")).mockResolvedValue(undefined);
  const desktop = new DesktopUpdater("1.0.0", save);
  updater.listeners.get("update-downloaded")!({ version: "1.1.0" });
  await desktop.install();
  expect(updater.quitAndInstall).not.toHaveBeenCalled();
  expect(desktop.state().status).toEqual({ type: "ready", version: "1.1.0" });
  await desktop.install();
  expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true);
});
