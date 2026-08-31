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
import { editPayload, editTextMessageAsV1, interactionPayload, messagePayload } from "./utils/discord-message.js";

const CUSTOM_ID_PREFIX = "furet_button";
const MAX_CONTENT_LENGTH = 1600;
const MAX_PREVIEW_LENGTH = 850;
const MAX_RESULT_LENGTH = 350;
const MAX_MESSAGE_LENGTH = 1950;
// Discord action rows hold at most 5 buttons; a message holds at most 5 rows.
const BUTTONS_PER_ROW = 5;
const MAX_ROWS = 5;
const MAX_BUTTONS = BUTTONS_PER_ROW * MAX_ROWS; // 25
let buttonQueue: Promise<void> = Promise.resolve();
const activeButtonExecutions = new Set<string>();

export type DiscordButtonStyle = "primary" | "secondary" | "success" | "danger";
export type DiscordButtonBehavior = "execute" | "edit" | "close";
export type DiscordButtonMessageStatus = "pending" | "processing" | "completed" | "closed" | "failed" | "expired";
/**
 * Interaction mode for a button set.
 * - "group" (default, backward compatible): the FIRST action (execute/close) ends the whole
 *   set — components are removed and a final status is shown.
 * - "independent": each button acts on its own. Approving/executing one button disables only
 *   that button (greyed, persisted); the rest stay clickable. The set stays "pending" until
 *   every actionable button is disabled, then shows a completed status while keeping the grey
 *   buttons visible.
 */
export type DiscordButtonInteractionMode = "group" | "independent";

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
  /**
   * Independent mode only. When this execute button completes successfully, mark every
   * actionable button in the set as disabled (not just this one). Use it for an
   * "Approve All" style button that subsumes the individual per-item buttons.
   */
  disableAllOnComplete?: boolean;
}

/** Per-button outcome for independent-mode sets, so renderContent can show individual results. */
export interface DiscordButtonResult {
  status: "completed" | "failed";
  text: string;
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
  interactionMode: DiscordButtonInteractionMode;
  /** Button IDs already acted on (independent mode). Rendered greyed + disabled, persisted. */
  disabledButtonIds: string[];
  /** Per-button outcome (independent mode). Drives ☑️/❌ rendering and per-button result text. */
  buttonResults?: Record<string, DiscordButtonResult>;
  /** Button IDs currently executing (independent mode, transient render state only). */
  processingButtonIds?: string[];
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
  interactionMode?: DiscordButtonInteractionMode;
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
    // Backward compat: records written before independent mode lack these fields.
    for (const m of parsed.messages) {
      if (m.interactionMode !== "independent") m.interactionMode = "group";
      if (!Array.isArray(m.disabledButtonIds)) m.disabledButtonIds = [];
      if (m.buttonResults === null || typeof m.buttonResults !== "object") m.buttonResults = {};
      // This field is only attached to a cloned record while rendering. Older versions
      // could persist it, so always discard stale values read from disk.
      delete m.processingButtonIds;
    }
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
  // Independent mode surfaces each finished button's own result so the owner can see
  // which files were approved/restored even while other buttons remain actionable.
  if (isIndependent(record) && record.buttonResults) {
    const resultLines: string[] = [];
    for (const button of record.buttons) {
      const outcome = record.buttonResults[button.id];
      if (!outcome) continue;
      const icon = outcome.status === "completed" ? "☑️" : "❌";
      resultLines.push(`${icon} **${button.label}** — ${truncate(outcome.text, 200)}`);
    }
    if (resultLines.length) lines.push("", ...resultLines);
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

/**
 * True when this button set keeps buttons visible after actions (independent mode). A
 * button acted on is shown greyed + disabled; the whole set only loses its components when
 * it expires or (group mode) reaches a terminal status.
 */
function isIndependent(record: DiscordButtonMessageRecord): boolean {
  return record.interactionMode === "independent";
}

/**
 * A greyed, disabled button — used for already-acted-on buttons in independent mode.
 * Emoji: ⏳ while processing, ❌ when that button's recorded outcome failed, ☑️ otherwise.
 */
function disabledButton(record: DiscordButtonMessageRecord, button: DiscordButtonDefinition, processing: boolean): ButtonBuilder {
  const failed = record.buttonResults?.[button.id]?.status === "failed";
  return new ButtonBuilder()
    .setCustomId(`${CUSTOM_ID_PREFIX}:${record.id}:${button.id}`)
    .setLabel(button.label)
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(true)
    .setEmoji(processing ? "⏳" : failed ? "❌" : "☑️");
}

/** Buttons that represent an actionable operation (execute/close), i.e. not edit buttons. */
function actionableButtonIds(record: DiscordButtonMessageRecord): string[] {
  return record.buttons.filter(b => b.behavior !== "edit").map(b => b.id);
}

/** True when every actionable button has been disabled (independent mode completion). */
function allActionableDisabled(record: DiscordButtonMessageRecord): boolean {
  const disabled = new Set(record.disabledButtonIds ?? []);
  const actionable = actionableButtonIds(record);
  return actionable.length > 0 && actionable.every(id => disabled.has(id));
}

/**
 * Split buttons across as many action rows as needed (max 5 per row, max 5 rows). Group
 * mode drops components on any terminal status. Independent mode keeps them: acted-on
 * buttons render greyed + disabled and persist; expiry removes all components.
 */
function buildComponents(record: DiscordButtonMessageRecord) {
  if (record.status === "expired") return [];
  if (!isIndependent(record) && record.status !== "pending") return [];

  const disabled = new Set(record.disabledButtonIds ?? []);
  const processing = new Set(record.processingButtonIds ?? []);
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  const buttons = record.buttons.slice(0, MAX_BUTTONS);
  for (let i = 0; i < buttons.length; i += BUTTONS_PER_ROW) {
    if (rows.length >= MAX_ROWS) break;
    const row = new ActionRowBuilder<ButtonBuilder>();
    for (const button of buttons.slice(i, i + BUTTONS_PER_ROW)) {
      if (isIndependent(record) && (disabled.has(button.id) || processing.has(button.id))) {
        row.addComponents(disabledButton(record, button, processing.has(button.id)));
      } else {
        row.addComponents(
          new ButtonBuilder()
            .setCustomId(`${CUSTOM_ID_PREFIX}:${record.id}:${button.id}`)
            .setLabel(button.label)
            .setStyle(toButtonStyle(button.style)),
        );
      }
    }
    rows.push(row);
  }
  return rows;
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
  const result = await editTextMessageAsV1(message, resolveEmojiMarkup(renderContent(record)), {
    components: buildComponents(record),
    allowedMentions: { parse: [] },
  });

  if (result.messageId !== record.messageId) {
    const oldMessageId = record.messageId;
    record.messageId = result.messageId;
    await withButtonLock(async () => {
      const store = await loadStore();
      const current = store.messages.find(item => item.id === record.id);
      if (!current) return;
      current.messageId = result.messageId;
      await saveStore(store);
    });
    logger.info(
      { buttonMessageId: record.id, oldMessageId, newMessageId: result.messageId },
      "historical V2 button message migrated to V1",
    );
  }
  if (!result.historicalMessageDeleted) {
    logger.warn(
      { buttonMessageId: record.id, oldMessageId: message.id, newMessageId: result.messageId },
      "historical V2 button message migrated but old message could not be deleted",
    );
  }
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
    throw new Error(`buttons must contain 1-${MAX_BUTTONS} items (max ${BUTTONS_PER_ROW} per row across ${MAX_ROWS} rows)`);
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
    interactionMode: input.interactionMode === "independent" ? "independent" : "group",
    disabledButtonIds: [],
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
    if (isIndependent(record)) return handleIndependentExecute(interaction, client, executeAction, parsed, button.id);

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
      finalStatus = isToolFailure(result) ? "failed" : "completed";
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

/** Heuristic for a tool string result that represents a failure. */
function isToolFailure(result: string): boolean {
  return /^(?:Error:|Unknown tool:|⚠️)/u.test(result.trim());
}

/**
 * Independent-mode execute: acts on a single button without ending the whole set.
 *
 * - Guards against double-click: a button already disabled or currently processing is
 *   rejected with an ephemeral notice.
 * - Marks the button `processing` (⏳), runs the action, then moves it to
 *   `disabledButtonIds` and records the outcome in `buttonResults` (☑️ success / ❌ fail).
 * - A `disableAllOnComplete` button that succeeds disables every actionable button
 *   (e.g. "Approve All" subsuming the per-file buttons).
 * - The whole record stays `pending` until every actionable button is disabled; then it
 *   transitions to `completed`. The message is re-edited after every state change.
 */
async function handleIndependentExecute(
  interaction: Interaction,
  client: Client,
  executeAction: DiscordButtonActionExecutor,
  parsed: { recordId: string; buttonId: string },
  buttonId: string,
): Promise<boolean> {
  if (!interaction.isButton()) return true;
  const executionKey = `${parsed.recordId}:${buttonId}`;

  // Claim the button (anti double-click) inside the lock.
  const claim = await withButtonLock(async () => {
    const store = await loadStore();
    const current = store.messages.find(item => item.id === parsed.recordId);
    if (!current || current.status !== "pending") {
      return { ok: false as const, status: current?.status };
    }
    const disabled = new Set(current.disabledButtonIds ?? []);
    if (disabled.has(buttonId) || activeButtonExecutions.has(executionKey)) {
      return { ok: false as const, alreadyActed: true };
    }
    activeButtonExecutions.add(executionKey);
    const rendering = structuredClone(current);
    rendering.processingButtonIds = [buttonId];
    return { ok: true as const, record: rendering };
  });

  if (!claim.ok) {
    const msg = claim.alreadyActed
      ? "這顆按鈕已經執行過了。"
      : claim.status
        ? `這組按鈕目前是「${statusLabel(claim.status)}」。`
        : "這組按鈕已不存在。";
    await interaction.reply(interactionPayload(msg, { ephemeral: true })).catch(() => {});
    return true;
  }

  await interaction.deferUpdate().catch(() => {});
  await editButtonMessage(client, claim.record).catch(err =>
    logger.error({ err, buttonMessageId: parsed.recordId, buttonId }, "failed to render processing state"));

  const actionButton = getButton(claim.record, buttonId)!;
  let failed: boolean;
  let result: string;
  try {
    result = await executeAction(actionButton.actionTool!, actionButton.actionArgs!);
    failed = isToolFailure(result);
  } catch (err) {
    failed = true;
    result = `Error: ${(err as Error).message}`;
    logger.error({ err, buttonMessageId: parsed.recordId, buttonId, actionTool: actionButton.actionTool }, "Discord button action failed");
  }

  const outcomeText = !failed && actionButton.resultText ? actionButton.resultText : result;

  const finalized = await withButtonLock(async () => {
    try {
      const store = await loadStore();
      const current = store.messages.find(item => item.id === parsed.recordId);
      if (!current) return undefined;
      const disabled = new Set(current.disabledButtonIds ?? []);
      disabled.add(buttonId);
      // A successful disableAllOnComplete button subsumes the rest.
      if (!failed && actionButton.disableAllOnComplete) {
        for (const id of actionableButtonIds(current)) disabled.add(id);
      }
      current.disabledButtonIds = [...disabled];
      current.buttonResults = { ...(current.buttonResults ?? {}), [buttonId]: { status: failed ? "failed" : "completed", text: outcomeText } };
      if (allActionableDisabled(current)) {
        current.status = "completed";
        current.decidedAt = new Date().toISOString();
      }
      await saveStore(store);
      return structuredClone(current);
    } finally {
      activeButtonExecutions.delete(executionKey);
    }
  });

  if (finalized) {
    await editButtonMessage(client, finalized).catch(err =>
      logger.error({ err, buttonMessageId: parsed.recordId, buttonId }, "failed to render finalized independent button"));
  }
  logger.info(
    { buttonMessageId: parsed.recordId, buttonId, actionTool: actionButton.actionTool, status: failed ? "failed" : "completed", setStatus: finalized?.status },
    "independent button action completed",
  );
  return true;
}
