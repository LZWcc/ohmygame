import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({
  appEvents: new Map<string, (...args: any[]) => void>(),
  ipcEvents: new Map<string, (...args: any[]) => void>(),
  handlers: new Map<string, (...args: any[]) => any>(),
  windowEvents: new Map<string, (...args: any[]) => void>(),
  sender: { send: vi.fn() },
  stopped: vi.fn(async () => {}),
  quit: vi.fn(), relaunch: vi.fn(), close: vi.fn(),
  install: undefined as (() => Promise<void>) | undefined,
  options: undefined as Record<string, unknown> | undefined,
}));
vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    on: (name: string, fn: (...args: any[]) => void) => host.appEvents.set(name, fn),
    whenReady: async () => {}, getPath: () => "/tmp/ohmygame-close-test", getVersion: () => "0.0.0",
    isReady: () => true, quit: host.quit, relaunch: host.relaunch, exit: vi.fn(),
  },
  ipcMain: {
    handle: (name: string, fn: (...args: any[]) => any) => host.handlers.set(name, fn),
    on: (name: string, fn: (...args: any[]) => void) => host.ipcEvents.set(name, fn),
  },
  nativeTheme: {}, session: { fromPartition: () => ({ setProxy: async () => {} }), defaultSession: { setProxy: async () => {} } },
  BrowserWindow: {}, clipboard: {}, dialog: { showErrorBox: vi.fn() }, Menu: {}, shell: {},
}));
vi.mock("undici/index.js", () => ({ setGlobalDispatcher: vi.fn() }));
vi.doMock(path.resolve("src/daemon/environment.ts"), () => ({ loadEnvironmentFiles: vi.fn() }));
vi.doMock(path.resolve("src/daemon/proxy.ts"), () => ({ createNetworkDispatcher: vi.fn() }));
vi.doMock(path.resolve("src/desktop/network.ts"), () => ({
  prepareDesktopNetwork: async () => ({ active: {}, environment: {} }), electronProxyConfig: () => ({}), proxyCredentials: vi.fn(),
}));
vi.doMock(path.resolve("src/desktop/daemon-process.ts"), () => ({
  startDaemon: async () => ({ runtime: { url: "http://127.0.0.1:12345", token: "test" }, stop: host.stopped }),
}));
vi.doMock(path.resolve("src/desktop/oauth.ts"), () => ({
  isOAuthAuthorizationUrl: vi.fn(), OAuthCallbackFlow: class { cancel = async () => {}; },
}));
vi.doMock(path.resolve("src/desktop/playtest-driver.ts"), () => ({ ElectronPlaytestDriver: class { close() {} } }));
vi.doMock(path.resolve("src/desktop/web-game-player.ts"), () => ({ WebGamePlayerWindows: class { close() {} } }));
vi.doMock(path.resolve("src/desktop/updater.ts"), () => ({ DesktopUpdater: class {
  constructor(_version: string, install: () => Promise<void>) { host.install = install; }
  subscribe() {} check() {}
} }));
vi.doMock(path.resolve("src/desktop/window.ts"), () => ({
  createDesktopWindow: async (options: { beforeLoad(window: unknown): void }) => {
    host.options = options as unknown as Record<string, unknown>;
    const window = {
      webContents: host.sender, isDestroyed: () => false, close: host.close,
      on: (name: string, fn: (...args: any[]) => void) => host.windowEvents.set(name, fn),
      once: (name: string, fn: (...args: any[]) => void) => host.windowEvents.set(name, fn),
    };
    options.beforeLoad(window);
    return window;
  },
  waitForRenderer: async () => {}, fitPlaytestContentSize: vi.fn(), isValidPlaytestViewport: vi.fn(), windowsTitleBarOverlay: vi.fn(),
}));

beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks(); vi.useFakeTimers();
  host.appEvents.clear(); host.ipcEvents.clear(); host.handlers.clear(); host.windowEvents.clear();
  process.argv.push("--built-renderer");
  host.quit.mockImplementation(() => host.appEvents.get("before-quit")!({ preventDefault() {} }));
  await import("../src/desktop/main.js");
  expect(host.options?.rendererFile).toMatch(/renderer\/index.html$/);
});
afterEach(() => { process.argv.splice(process.argv.lastIndexOf("--built-renderer"), 1); vi.useRealTimers(); });

const settle = async () => { await vi.advanceTimersByTimeAsync(0); };
function acknowledge(error?: string, sender = host.sender, id?: number) {
  const sent = host.sender.send.mock.calls.findLast(([channel]) => channel === "ohmygame:prepare-close")!;
  host.ipcEvents.get("ohmygame:ready-to-close")!({ sender }, id ?? sent[1], error);
}
function quit() { const event = { preventDefault: vi.fn() }; host.appEvents.get("before-quit")!(event); expect(event.preventDefault).toHaveBeenCalledOnce(); }

it("keeps services running until Quit receives a save acknowledgement", async () => {
  quit(); quit();
  expect(host.sender.send).toHaveBeenCalledTimes(1);
  expect(host.stopped).not.toHaveBeenCalled();
  acknowledge(); await settle();
  expect(host.stopped).toHaveBeenCalledOnce();
  expect(host.quit).toHaveBeenCalledOnce();
});
it("saves before closing a window and shares that save with a concurrent Quit", async () => {
  const event = { preventDefault: vi.fn() };
  host.windowEvents.get("close")!(event);
  expect(event.preventDefault).toHaveBeenCalledOnce();
  expect(host.close).not.toHaveBeenCalled();
  quit(); acknowledge(); await settle();
  expect(host.sender.send).toHaveBeenCalledTimes(1);
  expect(host.close).not.toHaveBeenCalled();
  expect(host.stopped).toHaveBeenCalledOnce();
});
it("closes a saved macOS window while keeping the daemon alive", async () => {
  host.windowEvents.get("close")!({ preventDefault() {} });
  acknowledge(); await settle();
  expect(host.close).toHaveBeenCalledOnce();
  expect(host.stopped).not.toHaveBeenCalled();
});
it("cancels a failed Quit and permits a later retry", async () => {
  quit(); acknowledge("Resolve the board conflict before saving."); await settle();
  expect(host.stopped).not.toHaveBeenCalled();
  expect(host.quit).not.toHaveBeenCalled();
  expect(host.sender.send).toHaveBeenLastCalledWith("ohmygame:cancel-close", 1, expect.stringContaining("conflict"));
  quit(); acknowledge(); await settle();
  expect(host.stopped).toHaveBeenCalledOnce();
});
it("rejects foreign and stale acknowledgements and resumes after a timeout", async () => {
  quit(); acknowledge(undefined, { send: vi.fn() }); acknowledge(undefined, host.sender, 0);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(host.stopped).not.toHaveBeenCalled();
  expect(host.sender.send).toHaveBeenLastCalledWith("ohmygame:cancel-close", 1, expect.stringContaining("too long"));
  quit(); acknowledge(undefined, host.sender, 1); await settle();
  expect(host.stopped).not.toHaveBeenCalled();
  acknowledge(); await settle();
  expect(host.stopped).toHaveBeenCalledOnce();
});
it("does not schedule a restart until its save succeeds", async () => {
  host.handlers.get("ohmygame:restart-app")!({ sender: host.sender });
  expect(host.relaunch).not.toHaveBeenCalled();
  acknowledge("Disk unavailable"); await settle();
  expect(host.relaunch).not.toHaveBeenCalled();
  host.handlers.get("ohmygame:restart-app")!({ sender: host.sender });
  acknowledge(); await settle();
  expect(host.relaunch).toHaveBeenCalledOnce();
  expect(host.stopped).toHaveBeenCalledOnce();
});
it("requires the same save acknowledgement before installing an update", async () => {
  const installing = host.install!();
  expect(host.stopped).not.toHaveBeenCalled();
  acknowledge(); await installing;
  expect(host.stopped).toHaveBeenCalledOnce();
});
