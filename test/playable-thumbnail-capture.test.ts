import { expect, it, vi } from "vitest";
import { AsyncTaskPool } from "../src/desktop/async-task-pool.js";
import {
  capturePlayableThumbnails,
  type PendingPlayableThumbnail,
} from "../src/renderer/playable-thumbnail-capture.js";

it("limits captures to two while publishing successes before a timeout finishes", async () => {
  const pool = new AsyncTaskPool(2);
  const pending = ["one", "two", "three", "four"].map(
    (nodeId): PendingPlayableThumbnail => ({ nodeId, hash: nodeId }),
  );
  const tasks = new Map(
    pending.map(({ nodeId }) => {
      let resolve!: (captured: boolean) => void;
      const promise = new Promise<boolean>((done) => {
        resolve = done;
      });
      return [nodeId, { promise, resolve }] as const;
    }),
  );
  const started: string[] = [];
  const published: string[] = [];
  let active = 0;
  let maximumActive = 0;

  const completed = capturePlayableThumbnails(
    pending,
    ({ nodeId }) =>
      pool.run(async () => {
        started.push(nodeId);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        try {
          return await tasks.get(nodeId)!.promise;
        } finally {
          active -= 1;
        }
      }),
    async ({ nodeId }) => {
      published.push(nodeId);
    },
  );

  await vi.waitFor(() => expect(started).toEqual(["one", "two"]));
  tasks.get("two")!.resolve(true);
  await vi.waitFor(() => {
    expect(published).toEqual(["two"]);
    expect(started).toEqual(["one", "two", "three"]);
  });
  tasks.get("three")!.resolve(true);
  await vi.waitFor(() => {
    expect(published).toEqual(["two", "three"]);
    expect(started).toEqual(["one", "two", "three", "four"]);
  });
  tasks.get("four")!.resolve(true);
  await vi.waitFor(() => expect(published).toEqual(["two", "three", "four"]));

  // The first capture times out only after every other result is already visible.
  tasks.get("one")!.resolve(false);
  await completed;
  expect(maximumActive).toBe(2);
  expect(active).toBe(0);
});

it("drops queued captures from the previous project before starting the next project", async () => {
  const pool = new AsyncTaskPool(2);
  const previousProject = new AbortController();
  const tasks = new Map(
    ["a-one", "a-two", "b-one", "b-two"].map((nodeId) => {
      let resolve!: (captured: boolean) => void;
      const promise = new Promise<boolean>((done) => {
        resolve = done;
      });
      return [nodeId, { promise, resolve }] as const;
    }),
  );
  const started: string[] = [];
  const candidates = (nodeIds: string[]): PendingPlayableThumbnail[] =>
    nodeIds.map((nodeId) => ({ nodeId, hash: nodeId }));
  const capture =
    (signal?: AbortSignal) =>
    ({ nodeId }: PendingPlayableThumbnail) =>
      pool.run(async () => {
        started.push(nodeId);
        return tasks.get(nodeId)?.promise ?? false;
      }, signal);

  const previous = capturePlayableThumbnails(
    candidates(["a-one", "a-two", "a-three", "a-four"]),
    capture(previousProject.signal),
    async () => {},
  );
  await vi.waitFor(() => expect(started).toEqual(["a-one", "a-two"]));

  previousProject.abort();
  const next = capturePlayableThumbnails(
    candidates(["b-one", "b-two"]),
    capture(),
    async () => {},
  );
  tasks.get("a-one")!.resolve(true);
  await vi.waitFor(() => expect(started).toEqual(["a-one", "a-two", "b-one"]));
  tasks.get("a-two")!.resolve(true);
  await vi.waitFor(() =>
    expect(started).toEqual(["a-one", "a-two", "b-one", "b-two"]),
  );

  tasks.get("b-one")!.resolve(true);
  tasks.get("b-two")!.resolve(true);
  await Promise.all([previous, next]);
  expect(started).not.toContain("a-three");
  expect(started).not.toContain("a-four");
});
