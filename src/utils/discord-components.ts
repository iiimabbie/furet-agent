import { basename, extname } from "node:path";
import {
  AttachmentBuilder,
  FileBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  ComponentType,
  ContainerBuilder,
  MessageFlags,
  TextDisplayBuilder,
  type InteractionReplyOptions,
  type MessageCreateOptions,
  type MessageEditOptions,
} from "discord.js";

type TopLevelComponent = NonNullable<MessageCreateOptions["components"]>[number];

export interface V2MessageOptions {
  files?: readonly string[];
  components?: readonly TopLevelComponent[];
  allowedMentions?: MessageCreateOptions["allowedMentions"];
  reply?: MessageCreateOptions["reply"];
  ephemeral?: boolean;
  replaceAttachments?: boolean;
}

interface V2CorePayload {
  components: TopLevelComponent[];
  files?: AttachmentBuilder[];
}

const IMAGE_EXTENSIONS = new Set([".apng", ".avif", ".gif", ".jpeg", ".jpg", ".png", ".webp"]);

function uniqueAttachmentName(path: string, used: Set<string>): string {
  const original = basename(path) || "attachment";
  const extension = extname(original);
  const stem = extension ? original.slice(0, -extension.length) : original;
  let candidate = original;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${stem}-${suffix}${extension}`;
    suffix++;
  }
  used.add(candidate);
  return candidate;
}

function buildCore(content: string | undefined, options: V2MessageOptions): V2CorePayload {
  const components: TopLevelComponent[] = [];
  if (content) components.push(new TextDisplayBuilder().setContent(content));
  if (options.components?.length) components.push(...options.components);

  if (!options.files?.length) return { components };

  if (options.files.length > 10) throw new Error("Discord messages support at most 10 attachments");

  const usedNames = new Set<string>();
  const files: AttachmentBuilder[] = [];
  const gallery = new MediaGalleryBuilder();
  const fileComponents: FileBuilder[] = [];
  let galleryItems = 0;

  for (const path of options.files) {
    const name = uniqueAttachmentName(path, usedNames);
    files.push(new AttachmentBuilder(path).setName(name));
    const attachmentUrl = `attachment://${name}`;
    if (IMAGE_EXTENSIONS.has(extname(name).toLowerCase())) {
      gallery.addItems(new MediaGalleryItemBuilder().setURL(attachmentUrl));
      galleryItems++;
    } else {
      fileComponents.push(new FileBuilder().setURL(attachmentUrl));
    }
  }

  const attachmentContainer = new ContainerBuilder();
  if (galleryItems > 0) attachmentContainer.addMediaGalleryComponents(gallery);
  if (fileComponents.length > 0) attachmentContainer.addFileComponents(...fileComponents);
  components.push(attachmentContainer);
  return { components, files };
}

/** Build a Discord Components V2 channel-message payload. */
export function v2Message(content?: string, options: V2MessageOptions = {}): MessageCreateOptions {
  const core = buildCore(content, options);
  return {
    ...core,
    flags: MessageFlags.IsComponentsV2,
    ...(options.allowedMentions ? { allowedMentions: options.allowedMentions } : {}),
    ...(options.reply ? { reply: options.reply } : {}),
  };
}

/** Build a Discord Components V2 interaction response payload. */
export function v2Interaction(content?: string, options: V2MessageOptions = {}): InteractionReplyOptions {
  const core = buildCore(content, options);
  return {
    ...core,
    flags: options.ephemeral
      ? MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral
      : MessageFlags.IsComponentsV2,
    ...(options.allowedMentions ? { allowedMentions: options.allowedMentions } : {}),
  };
}

/** Build a Discord Components V2 edit payload. Once enabled, V2 cannot be reverted. */
export function v2Edit(content?: string, options: V2MessageOptions = {}): MessageEditOptions {
  const core = buildCore(content, options);
  return {
    ...core,
    // Discord requires legacy fields to be explicitly cleared when an existing
    // legacy message is converted to Components V2 during an edit.
    content: null,
    embeds: [],
    flags: MessageFlags.IsComponentsV2,
    ...(options.allowedMentions ? { allowedMentions: options.allowedMentions } : {}),
    ...(options.replaceAttachments ? { attachments: [] } : {}),
  };
}

/** Raw JSON body for direct Discord webhook PATCH requests. */
export function v2WebhookBody(content: string): Record<string, unknown> {
  return {
    content: null,
    embeds: [],
    components: [new TextDisplayBuilder().setContent(content).toJSON()],
    flags: MessageFlags.IsComponentsV2,
  };
}

/** Read all user-visible text from Discord message content, embeds, and Components V2. */
export function extractMessageText(message: {
  content?: string | null;
  embeds?: readonly { toJSON?: () => unknown }[];
  components?: readonly { toJSON?: () => unknown }[];
}): string {
  const texts: string[] = [];
  const addText = (value: unknown): void => {
    if (typeof value === "string" && value.trim()) texts.push(value);
  };

  addText(message.content);

  for (const embedValue of message.embeds ?? []) {
    const embed = (embedValue.toJSON ? embedValue.toJSON() : embedValue) as {
      author?: { name?: unknown };
      title?: unknown;
      description?: unknown;
      fields?: unknown;
      footer?: { text?: unknown };
    };
    addText(embed.author?.name);
    addText(embed.title);
    addText(embed.description);
    if (Array.isArray(embed.fields)) {
      for (const fieldValue of embed.fields) {
        if (!fieldValue || typeof fieldValue !== "object") continue;
        const field = fieldValue as { name?: unknown; value?: unknown };
        addText(field.name);
        addText(field.value);
      }
    }
    addText(embed.footer?.text);
  }

  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    const component = value as { type?: number; content?: unknown; components?: unknown };
    if (component.type === ComponentType.TextDisplay) addText(component.content);
    if (Array.isArray(component.components)) {
      for (const child of component.components) visit(child);
    }
  };

  for (const component of message.components ?? []) {
    visit(component.toJSON ? component.toJSON() : component);
  }
  return texts.join("\n");
}

export interface ExtractedMessageAttachment {
  url: string;
  name?: string;
  contentType?: string;
}

/** Read user-visible attachments from uploads, embeds, and Components V2. */
export function extractMessageAttachments(message: {
  attachments?: { values?: () => Iterable<{ url: string; name?: string | null; contentType?: string | null }> };
  embeds?: readonly { toJSON?: () => unknown }[];
  components?: readonly { toJSON?: () => unknown }[];
}): ExtractedMessageAttachment[] {
  const results: ExtractedMessageAttachment[] = [];
  const seen = new Set<string>();
  const add = (url: unknown, name?: unknown, contentType?: unknown): void => {
    if (typeof url !== "string" || seen.has(url)) return;
    seen.add(url);
    results.push({
      url,
      ...(typeof name === "string" ? { name } : {}),
      ...(typeof contentType === "string" ? { contentType } : {}),
    });
  };

  const attachmentValues = message.attachments?.values?.();
  if (attachmentValues) {
    for (const attachment of attachmentValues) add(attachment.url, attachment.name, attachment.contentType);
  }

  for (const embedValue of message.embeds ?? []) {
    const embed = (embedValue.toJSON ? embedValue.toJSON() : embedValue) as {
      image?: { url?: unknown };
      thumbnail?: { url?: unknown };
    };
    add(embed.image?.url);
    add(embed.thumbnail?.url);
  }

  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    const node = value as {
      name?: unknown;
      file?: { url?: unknown; content_type?: unknown };
      media?: { url?: unknown; content_type?: unknown };
      components?: unknown;
      items?: unknown;
    };
    if (node.file) add(node.file.url, node.name, node.file.content_type);
    if (node.media) add(node.media.url, node.name, node.media.content_type);
    if (Array.isArray(node.components)) for (const child of node.components) visit(child);
    if (Array.isArray(node.items)) for (const child of node.items) visit(child);
  };

  for (const component of message.components ?? []) {
    visit(component.toJSON ? component.toJSON() : component);
  }
  return results;
}
