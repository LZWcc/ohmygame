import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import {
  PLUGIN_ICON_MAX_BYTES,
  PLUGIN_ICON_MAX_DIMENSION,
} from "../shared/plugin-icons.js";
import {
  isPluginIcon,
  type PluginIcon,
  type PluginDetail,
} from "../shared/plugins.js";
import { sniffImageType } from "./image-format.js";

export async function validatePluginIconImage(
  bytes: Buffer,
  expected?: string,
) {
  if (!bytes.length || bytes.length > PLUGIN_ICON_MAX_BYTES)
    throw new Error("Plugin icons must be between 1 byte and 1 MB");
  const mediaType = sniffImageType(bytes);
  if (
    (mediaType !== "image/png" && mediaType !== "image/webp") ||
    (expected && mediaType !== expected)
  )
    throw new Error("Choose a PNG or WebP plugin icon");
  const { PhotonImage } = await import("@silvia-odwyer/photon-node");
  let image: InstanceType<typeof PhotonImage> | undefined;
  try {
    image = PhotonImage.new_from_byteslice(bytes);
    if (
      !image.get_width() ||
      !image.get_height() ||
      image.get_width() > PLUGIN_ICON_MAX_DIMENSION ||
      image.get_height() > PLUGIN_ICON_MAX_DIMENSION
    )
      throw new Error("Plugin icons must be at most 2048 × 2048 pixels");
  } catch (cause) {
    throw new Error(
      cause instanceof Error
        ? cause.message
        : "The plugin icon could not be decoded",
    );
  } finally {
    image?.free();
  }
  return {
    bytes,
    mediaType,
    revision: createHash("sha256").update(bytes).digest("hex"),
  };
}

export async function readPluginIconAsset(
  root: string,
  icon: PluginIcon | undefined,
) {
  if (icon?.type !== "asset") return undefined;
  if (!isPluginIcon(icon)) throw new Error("Invalid plugin icon path");
  const packageRoot = await realpath(root);
  let target = packageRoot;
  for (const part of icon.path.slice(2).split("/")) {
    target = path.join(target, part);
    const info = await lstat(target);
    if (info.isSymbolicLink())
      throw new Error("Plugin icons must not contain symbolic links");
  }
  const relative = path.relative(packageRoot, await realpath(target));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("Plugin icon must be inside its package");
  const info = await lstat(target);
  if (!info.isFile() || info.size > PLUGIN_ICON_MAX_BYTES)
    throw new Error("Choose a plugin icon file up to 1 MB");
  return validatePluginIconImage(
    await readFile(target),
    icon.path.endsWith(".png") ? "image/png" : "image/webp",
  );
}

export function registerPluginIconRoutes(
  app: FastifyInstance,
  plugins: { read(id: string): Promise<PluginDetail | undefined> },
  roots: readonly {
    installedPath(id: string): string | undefined | Promise<string | undefined>;
  }[],
) {
  app.get<{ Params: { pluginId: string } }>(
    "/plugins/:pluginId/icon",
    async (request, reply) => {
      try {
        const plugin = await plugins.read(request.params.pluginId);
        if (!plugin?.installed || plugin.icon?.type !== "asset")
          return reply.code(404).send({ error: "Plugin icon not found" });
        const candidates = await Promise.all(
          roots.map((store) => store.installedPath(plugin.id)),
        );
        const root = candidates.find(Boolean);
        const image = root
          ? await readPluginIconAsset(root, plugin.icon)
          : undefined;
        if (!image)
          return reply.code(404).send({ error: "Plugin icon not found" });
        return reply
          .header("Cache-Control", "no-store")
          .header("X-Content-Type-Options", "nosniff")
          .type(image.mediaType)
          .send(image.bytes);
      } catch {
        return reply.code(404).send({ error: "Plugin icon not found" });
      }
    },
  );
}
