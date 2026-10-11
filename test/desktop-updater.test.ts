import { beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopUpdater } from "../src/desktop/updater.js";

const mocks = vi.hoisted(() => {
  const appListeners = new Map<string, () => void>();
  const updaterListeners = new Map<
    string,
    (value: { version: string }) => void
  >();
  const calls: string[] = [];
  const app = {
    isPackaged: true,
    once: vi.fn((event: string, listener: () => void) => {
      appListeners.set(event, listener);
    }),
    quit: vi.fn(() => {
      calls.push("quit");
    }),
  };
  const autoUpdater = {
    autoRunAppAfterInstall: false,
    checkForUpdates: vi.fn(),
    on: vi.fn(
      (event: string, listener: (value: { version: string }) => void) => {
        updaterListeners.set(event, listener);
      },
    ),
    quitAndInstall: vi.fn(() => {
      calls.push("install");
    }),
  };
  return { app, autoUpdater, appListeners, updaterListeners, calls };
});

vi.mock("electron", () => ({ app: mocks.app }));
vi.mock("electron-updater", () => ({
  default: { autoUpdater: mocks.autoUpdater },
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.appListeners.clear();
  mocks.updaterListeners.clear();
  mocks.calls.length = 0;
  mocks.autoUpdater.autoRunAppAfterInstall = false;
});

describe("desktop update installation", () => {
  it("waits for service cleanup and launches the Windows installer when the app is quitting", async () => {
    let finishCleanup!: () => void;
    const cleanup = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishCleanup = resolve;
        }),
    );
    const updater = new DesktopUpdater("0.1.0", cleanup);
    mocks.updaterListeners.get("update-downloaded")?.({ version: "0.2.0" });

    const first = updater.install();
    const duplicate = updater.install();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(mocks.autoUpdater.quitAndInstall).not.toHaveBeenCalled();
    finishCleanup();
    await Promise.all([first, duplicate]);

    if (process.platform === "win32") {
      expect(mocks.calls).toEqual(["quit"]);
      const listener = mocks.appListeners.get("will-quit");
      expect(listener).toBeDefined();
      listener?.();
      expect(mocks.calls).toEqual(["quit", "install"]);
    } else {
      expect(mocks.calls).toEqual(["install"]);
    }
    await updater.install();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(mocks.autoUpdater.autoRunAppAfterInstall).toBe(true);
    expect(mocks.autoUpdater.quitAndInstall).toHaveBeenCalledWith(false);
    expect(mocks.autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("does not start the installer when service cleanup fails", async () => {
    const updater = new DesktopUpdater("0.1.0", () =>
      Promise.reject(new Error("Daemon did not exit")),
    );
    mocks.updaterListeners.get("update-downloaded")?.({ version: "0.2.0" });

    await updater.install();

    expect(updater.state().status).toEqual({
      type: "error",
      message: "Daemon did not exit",
      restartRequired: true,
    });
    await updater.check();
    expect(mocks.autoUpdater.checkForUpdates).not.toHaveBeenCalled();
    expect(mocks.autoUpdater.quitAndInstall).not.toHaveBeenCalled();
    expect(mocks.app.quit).not.toHaveBeenCalled();
  });
});
