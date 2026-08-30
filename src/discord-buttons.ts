import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type Client,
  type Interaction,
  type Message,
} from "discord.js";
import { loadConfig } from "./config.js";
import { logger } from "./logger.js";
import { DISCORD_BUTTONS_FILE, WORKSPACE_CONFIG_DIR } from "./paths.js";
import { resolveEmojiMarkup } from "./emoji.js";
import { editPayload, interactionPayload, messagePayload } from "./utils/discord-message.js";

const CUSTOM_ID_PREFIX = "furet_button";
const MAX_CONTENT_LENGTH = 1600;
const MAX_PREVIEW_LENGTH = 850;
const MAX_RESULT_LENGTH = 350;
const MAX_MESSAGE_LENGTH = 1950;
const MAX_BUTTONS = 5;
let buttonQueue: Promise<void> = Promise.resolve();

export type DiscordButtonStyle = "primary" | "secondary" | "success" | "danger";
export type DiscordButtonBehavior = "execute" | "edit" | "close";
export type DiscordButtonMessageStatus = "pending" | "processing" | "completed" | "closed" | "failed" | "expired";

export interface DiscordButtonDefinition {
  id: string;
  label: string;
  style: DiscordButtonStyle;
  behavior: DiscordButtonBehavior;
  actionTool?: string;
  actionArgs?: Record<string, unknown>;
  targetButtonId?: string;
  editableField?: string;
  editableLabel?: string;
  resultText?: string;
}

export interface DiscordButtonMessageRecord {
  id: string;
  channelId: string;
  messageId: string;
  content: string;
  buttons: DiscordButtonDefinition[];
  allowedUserIds: string[];
  previewButtonId?: string;
  previewField?: string;
  previewLabel?: string;
  status: DiscordButtonMessageStatus;
  createdAt: string;
  expiresAt: string;
  decidedAt?: string;
  result?: string;
}

interface ButtonStore {
  version: 1;
  messages: DiscordButtonMessageRecord[];
}

export interface CreateDiscordButtonMessageInput {
  channelId: string;
  content: string;
  buttons: DiscordButtonDefinition[];
  allowedUserIds?: string[];
  previewButtonId?: string;
  previewField?: string;
  previewLabel?: string;
  expiresInMinutes?: number;
}

export interface DiscordButtonActionExecutor {
  (toolName: string, args: Record<string, unknown>): Promise<string>;
}

function emptyStore(): ButtonStore {
  return { version: 1, messages: [] };
}

async function loadStore(): Promise<ButtonStore> {
  try {
    const parsed = JSON.parse(await readFile(DISCORD_BUTTONS_FILE, "utf8")) as Partial<ButtonStore>;
    if (parsed.version !== 1 || !Array.isArray(parsed.messages)) return emptyStore();
    return { version: 1, messages: parsed.messages };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.error({ err }, "failed to read Discord button store");
    }
    return emptyStore();
  }
}

async function withButtonLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = buttonQueue;
  let release!: () => void;
  buttonQueue = new Promise<void>(resolve => { release = resolve; });
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

async function saveStore(store: ButtonStore): Promise<void> {
  await mkdir(WORKSPACE_CONFIG_DIR, { recursive: true });
  const tempPath = `${DISCORD_BUTTONS_FILE}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  await rename(tempPath, DISCORD_BUTTONS_FILE);
  await chmod(DISCORD_BUTTONS_FILE, 0o600);
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function quote(text: string): string {
  return text.split("\n").map(line => `> ${line || " "}`).join("\n");
}

function statusLabel(status: DiscordButtonMessageStatus): string {
  switch (status) {
    case "pending": return "等待操作";
    case "processing": return "執行中";
    case "completed": return "已完成";
    case "closed": return "已關閉";
    case "failed": return "執行失敗";
    case "expired": return "已過期";
  }
}

function getButton(record: DiscordButtonMessageRecord, buttonId: string): DiscordButtonDefinition | undefined {
  return record.buttons.find(button => button.id === buttonId);
}

function renderContent(record: DiscordButtonMessageRecord): string {
  const lines = [truncate(record.content, MAX_CONTENT_LENGTH)];
  if (record.previewButtonId && record.previewField) {
    const previewButton = getButton(record, record.previewButtonId);
    const value = previewButton?.actionArgs?.[record.previewField];
    if (typeof value === "string") {
      lines.push("", `**${record.previewLabel || "內容"}**`, quote(truncate(value, MAX_PREVIEW_LENGTH)));
    }
  }
  if (record.status !== "pending") lines.push("", `狀態：**${statusLabel(record.status)}**`);
  if (record.result) lines.push("", quote(truncate(record.result, MAX_RESULT_LENGTH)));
  return truncate(lines.join("\n"), MAX_MESSAGE_LENGTH);
}

function toButtonStyle(style: DiscordButtonStyle): ButtonStyle {
  switch (style) {
    case "primary": return ButtonStyle.Primary;
    case "secondary": return ButtonStyle.Secondary;
    case "success": return ButtonStyle.Success;
    case "danger": return ButtonStyle.Danger;
  }
}

function buildComponents(record: DiscordButtonMessageRecord) {
  if (record.status !== "pending") return [];
  const row = new ActionRowBuilder<ButtonBuilder>();
  for (const button of record.buttons) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`${CUSTOM_ID_PREFIX}:${record.id}:${button.id}`)
        .setLabel(button.label)
        .setStyle(toButtonStyle(button.style)),
    );
  }
  return [row];
}

async function fetchButtonMessage(client: Client, record: DiscordButtonMessageRecord): Promise<Message> {
  const channel = await client.channels.fetch(record.channelId);
  if (!channel || !channel.isTextBased() || !("messages" in channel)) {
    throw new Error(`button message channel ${record.channelId} is unavailable`);
  }
  return channel.messages.fetch(record.messageId);
}

async function editButtonMessage(client: Client, record: DiscordButtonMessageRecord): Promise<void> {
  const message = await fetchButtonMessage(client, record);
  await message.edit(editPayload(resolveEmojiMarkup(renderContent(record)), {
    components: buildComponents(record),
    allowedMentions: { parse: [] },
  }));
}

function parseCustomId(customId: string): { recordId: string; buttonId: string; modal: boolean } | undefined {
  const [prefix, recordId, buttonId, suffix] = customId.split(":");
  if (prefix !== CUSTOM_ID_PREFIX || !recordId || !buttonId) return undefined;
  return { recordId, buttonId, modal: suffix === "submit" };
}

function isExpired(record: DiscordButtonMessageRecord): boolean {
  return Date.now() >= Date.parse(record.expiresAt);
}

async function requireAllowedUser(record: DiscordButtonMessageRecord, interaction: Interaction): Promise<boolean> {
  if (record.allowedUserIds.includes(interaction.user.id)) return true;
  if (interaction.isRepliable()) {
    await interaction.reply(interactionPayload("你不能操作這些按鈕。", { ephemeral: true })).catch(() => {});
  }
  return false;
}

function validateButton(button: DiscordButtonDefinition, ids: Set<string>): void {
  if (!/^[a-zA-Z0-9_-]{1,32}$/.test(button.id)) throw new Error(`invalid button id: ${button.id}`);
  if (ids.has(button.id)) throw new Error(`duplicate button id: ${button.id}`);
  ids.add(button.id);
  if (!button.label?.trim() || button.label.length > 80) throw new Error(`button ${button.id} label must be 1-80 characters`);
  if (!["primary", "secondary", "success", "danger"].includes(button.style)) throw new Error(`invalid style for button ${button.id}`);
  if (!["execute", "edit", "close"].includes(button.behavior)) throw new Error(`invalid behavior for button ${button.id}`);
  if (button.behavior === "execute") {
    if (!button.actionTool?.trim()) throw new Error(`button ${button.id} requires action_tool`);
    if (!button.actionArgs || typeof button.actionArgs !== "object" || Array.isArray(button.actionArgs)) {
      throw new Error(`button ${button.id} action_args must be an object`);
    }
  }
  if (button.behavior === "edit") {
    if (!button.targetButtonId?.trim() || !button.editableField?.trim()) {
      throw new Error(`button ${button.id} requires target_button_id and editable_field`);
    }
    if (["__proto__", "prototype", "constructor"].includes(button.editableField)) {
      throw new Error(`button ${button.id} editable_field uses a reserved property name`);
    }
  }
}

export async function createDiscordButtonMessage(
  client: Client,
  input: CreateDiscordButtonMessageInput,
): Promise<DiscordButtonMessageRecord> {
  if (!input.content?.trim()) throw new Error("content is required");
  if (!Array.isArray(input.buttons) || input.buttons.length < 1 || input.buttons.length > MAX_BUTTONS) {
    throw new Error(`buttons must contain 1-${MAX_BUTTONS} items`);
  }
  const ids = new Set<string>();
  for (const button of input.buttons) validateButton(button, ids);
  for (const button of input.buttons.filter(item => item.behavior === "edit")) {
    const target = input.buttons.find(item => item.id === button.targetButtonId);
    if (!target || target.behavior !== "execute") throw new Error(`edit button ${button.id} must target an execute button`);
    if (typeof target.actionArgs?.[button.editableField!] !== "string") {
      throw new Error(`target button ${target.id} action_args.${button.editableField} must be a string`);
    }
  }
  if ((input.previewButtonId && !input.previewField) || (!input.previewButtonId && input.previewField)) {
    throw new Error("preview_button_id and preview_field must be provided together");
  }
  if (input.previewButtonId && input.previewField) {
    const previewButton = input.buttons.find(item => item.id === input.previewButtonId);
    if (!previewButton || previewButton.behavior !== "execute") throw new Error("preview_button_id must reference an execute button");
    if (typeof previewButton.actionArgs?.[input.previewField] !== "string") {
      throw new Error(`preview field ${input.previewField} must reference a string action argument`);
    }
  }

  const ownerId = loadConfig().discord.owner_id;
  const allowedUserIds = input.allowedUserIds?.length ? [...new Set(input.allowedUserIds)] : (ownerId ? [ownerId] : []);
  if (allowedUserIds.length === 0 || allowedUserIds.some(id => !/^\d{10,25}$/.test(id))) {
    throw new Error("allowed_user_ids must contain valid Discord user IDs, or discord.owner_id must be configured");
  }

  const channel = await client.channels.fetch(input.channelId);
  if (!channel || !channel.isTextBased() || !("send" in channel)) {
    throw new Error(`channel ${input.channelId} not found or not text-based`);
  }

  const requestedExpiry = Number.isFinite(input.expiresInMinutes) ? input.expiresInMinutes! : 1440;
  const expiresInMinutes = Math.min(Math.max(requestedExpiry, 1), 10080);
  const record: DiscordButtonMessageRecord = {
    id: randomUUID(),
    channelId: input.channelId,
    messageId: "",
    content: input.content,
    buttons: input.buttons,
    allowedUserIds,
    previewButtonId: input.previewButtonId,
    previewField: input.previewField,
    previewLabel: input.previewLabel,
    status: "pending",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + expiresInMinutes * 60_000).toISOString(),
  };

  const sent = await channel.send(messagePayload(resolveEmojiMarkup(renderContent(record)), {
    components: buildComponents(record),
    allowedMentions: { parse: [] },
  }));
  record.messageId = sent.id;

  try {
    await withButtonLock(async () => {
      const store = await loadStore();
      const retentionCutoff = Date.now() - 30 * 24 * 60 * 60_000;
      store.messages = store.messages.filter(item =>
        item.status === "pending" || item.status === "processing" || Date.parse(item.createdAt) >= retentionCutoff
      );
      store.messages.push(record);
      await saveStore(store);
    });
  } catch (err) {
    await sent.edit(editPayload(resolveEmojiMarkup(`${record.content}\n\n狀態：**按鈕狀態保存失敗**`), { allowedMentions: { parse: [] } })).catch(() => {});
    throw err;
  }
  logger.info({ buttonMessageId: record.id, messageId: sent.id, buttonCount: record.buttons.length }, "Discord button message created");
  return record;
}

export async function handleDiscordButtonInteraction(
  interaction: Interaction,
  client: Client,
  executeAction: DiscordButtonActionExecutor,
): Promise<boolean> {
  if (!interaction.isButton() && !interaction.isModalSubmit()) return false;
  const parsed = parseCustomId(interaction.customId);
  if (!parsed) return false;
  const getRecord = async (): Promise<DiscordButtonMessageRecord | undefined> =>
    withButtonLock(async () => {
      const store = await loadStore();
      const record = store.messages.find(item => item.id === parsed.recordId);
      return record ? structuredClone(record) : undefined;
    });

  let record = await getRecord();
  if (!record) {
    await interaction.reply(interactionPayload("這組按鈕已不存在。", { ephemeral: true })).catch(() => {});
    return true;
  }
  if (!(await requireAllowedUser(record, interaction))) return true;

  if (isExpired(record) && record.status === "pending") {
    const expired = await withButtonLock(async () => {
      const store = await loadStore();
      const current = store.messages.find(item => item.id === parsed.recordId);
      if (!current || current.status !== "pending") return current ? structuredClone(current) : undefined;
      current.status = "expired";
      current.decidedAt = new Date().toISOString();
      await saveStore(store);
      return structuredClone(current);
    });
    await interaction.deferUpdate().catch(() => {});
    if (expired) await editButtonMessage(client, expired).catch(err => logger.error({ err, buttonMessageId: parsed.recordId }, "failed to expire Discord buttons"));
    return true;
  }

  if (record.status !== "pending") {
    await interaction.reply(interactionPayload(`這組按鈕目前是「${statusLabel(record.status)}」。`, { ephemeral: true })).catch(() => {});
    return true;
  }

  const button = getButton(record, parsed.buttonId);
  if (!button) {
    await interaction.reply(interactionPayload("這顆按鈕已不存在。", { ephemeral: true })).catch(() => {});
    return true;
  }

  if (interaction.isButton() && button.behavior === "edit") {
    const target = getButton(record, button.targetButtonId!);
    const current = String(target?.actionArgs?.[button.editableField!] ?? "");
    const modal = new ModalBuilder()
      .setCustomId(`${CUSTOM_ID_PREFIX}:${record.id}:${button.id}:submit`)
      .setTitle(truncate(button.editableLabel || button.label, 45));
    const input = new TextInputBuilder()
      .setCustomId("value")
      .setLabel(truncate(button.editableLabel || "修改內容", 45))
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setMaxLength(4000)
      .setValue(current.slice(0, 4000));
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
    await interaction.showModal(modal);
    return true;
  }

  if (interaction.isModalSubmit() && parsed.modal && button.behavior === "edit") {
    const value = interaction.fields.getTextInputValue("value");
    const updated = await withButtonLock(async () => {
      const store = await loadStore();
      const current = store.messages.find(item => item.id === parsed.recordId);
      if (!current || current.status !== "pending") return current ? structuredClone(current) : undefined;
      const editButton = getButton(current, parsed.buttonId);
      const target = editButton?.targetButtonId ? getButton(current, editButton.targetButtonId) : undefined;
      if (!editButton?.editableField || !target?.actionArgs) return undefined;
      target.actionArgs[editButton.editableField] = value;
      await saveStore(store);
      return structuredClone(current);
    });
    if (!updated || updated.status !== "pending") {
      await interaction.reply(interactionPayload(updated ? `這組按鈕目前是「${statusLabel(updated.status)}」。` : "無法更新這組按鈕。", { ephemeral: true }));
      return true;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await editButtonMessage(client, updated);
    await interaction.editReply(editPayload("已更新內容。"));
    logger.info({ buttonMessageId: updated.id, buttonId: button.id }, "Discord button action edited");
    return true;
  }

  if (!interaction.isButton()) return true;

  if (button.behavior === "close") {
    const closed = await withButtonLock(async () => {
      const store = await loadStore();
      const current = store.messages.find(item => item.id === parsed.recordId);
      if (!current || current.status !== "pending") return current ? structuredClone(current) : undefined;
      current.status = "closed";
      current.result = button.resultText || button.label;
      current.decidedAt = new Date().toISOString();
      await saveStore(store);
      return structuredClone(current);
    });
    if (!closed || closed.status !== "closed") {
      await interaction.reply(interactionPayload(closed ? `這組按鈕目前是「${statusLabel(closed.status)}」。` : "這組按鈕已不存在。", { ephemeral: true }));
      return true;
    }
    await interaction.deferUpdate();
    await editButtonMessage(client, closed);
    logger.info({ buttonMessageId: closed.id, buttonId: button.id }, "Discord button message closed");
    return true;
  }

  if (button.behavior === "execute") {
    const transition = await withButtonLock(async () => {
      const store = await loadStore();
      const current = store.messages.find(item => item.id === parsed.recordId);
      if (!current || current.status !== "pending") return current ? { transitioned: false, record: structuredClone(current) } : { transitioned: false };
      current.status = "processing";
      await saveStore(store);
      return { transitioned: true, record: structuredClone(current) };
    });
    if (!transition.transitioned || !transition.record) {
      await interaction.reply(interactionPayload(transition.record ? `這組按鈕目前是「${statusLabel(transition.record.status)}」。` : "這組按鈕已不存在。", { ephemeral: true }));
      return true;
    }

    record = transition.record;
    const actionButton = getButton(record, button.id)!;
    await interaction.deferUpdate();
    await editButtonMessage(client, record);

    let finalStatus: DiscordButtonMessageStatus;
    let result: string;
    try {
      result = await executeAction(actionButton.actionTool!, actionButton.actionArgs!);
      finalStatus = /^(?:Error:|Unknown tool:|⚠️)/u.test(result.trim()) ? "failed" : "completed";
    } catch (err) {
      finalStatus = "failed";
      result = `Error: ${(err as Error).message}`;
      logger.error({ err, buttonMessageId: record.id, buttonId: button.id, actionTool: actionButton.actionTool }, "Discord button action failed");
    }

    const finalized = await withButtonLock(async () => {
      const store = await loadStore();
      const current = store.messages.find(item => item.id === record!.id);
      if (!current) return undefined;
      current.status = finalStatus;
      current.result = finalStatus === "completed" && actionButton.resultText ? actionButton.resultText : result;
      current.decidedAt = new Date().toISOString();
      await saveStore(store);
      return structuredClone(current);
    });
    if (finalized) await editButtonMessage(client, finalized);
    logger.info({ buttonMessageId: record.id, buttonId: button.id, actionTool: actionButton.actionTool, status: finalStatus }, "Discord button action completed");
    return true;
  }

  return true;
}
