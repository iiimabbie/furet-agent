import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import type { Tool } from "../../types.js";
import { loadConfig } from "../../config.js";
import { ATTACHMENTS_DIR, ROOT } from "../../paths.js";
import { queueAttachment } from "../context.js";
import { logger } from "../../logger.js";

type ImageFormat = "png" | "jpeg" | "webp";
type ImageQuality = "low" | "medium" | "high" | "auto";
type ImageSize = "auto" | "1024x1024" | "1536x1024" | "1024x1536";
type ImageBackground = "auto" | "transparent" | "opaque";
type InputFidelity = "low" | "high";

const MAX_REFERENCE_IMAGES = 4;
const MAX_REFERENCE_BYTES = 20 * 1024 * 1024;

function referenceDataUrl(rawPath: string): { path: string; dataUrl: string } {
  const candidate = isAbsolute(rawPath) ? resolve(rawPath) : resolve(ROOT, rawPath);
  const filePath = realpathSync(candidate);
  const attachmentsRoot = realpathSync(ATTACHMENTS_DIR);
  const rel = relative(attachmentsRoot, filePath);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Reference image must be inside ${ATTACHMENTS_DIR}`);
  }

  const stat = statSync(filePath);
  if (!stat.isFile()) throw new Error(`Reference image is not a file: ${filePath}`);
  if (stat.size > MAX_REFERENCE_BYTES) {
    throw new Error(`Reference image exceeds ${MAX_REFERENCE_BYTES} bytes: ${filePath}`);
  }

  const ext = extname(filePath).toLowerCase();
  const mime = ext === ".png" ? "image/png"
    : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg"
      : ext === ".webp" ? "image/webp"
        : null;
  if (!mime) throw new Error(`Unsupported reference image type: ${ext || "unknown"}`);
  return { path: filePath, dataUrl: `data:${mime};base64,${readFileSync(filePath).toString("base64")}` };
}

interface ImageGenerationCall {
  type?: string;
  result?: string;
  revised_prompt?: string;
  output_format?: string;
}

function isGptModel(model: string): boolean {
  return /^gpt(?:-|$)/i.test(model);
}

export const imageGen: Tool = {
  name: "image_gen",
  description: "Generate or edit an image and attach it to the final Discord reply. When depicting the agent itself, always set use_identity_reference=true so the configured canonical face is actually sent to the image model. Use reference_images for other image references. Never claim identity was preserved unless this tool returns success with references_used.",
  parameters: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "Detailed description of the image to generate." },
      size: {
        type: "string",
        enum: ["auto", "1024x1024", "1536x1024", "1024x1536"],
        description: "Output dimensions. Default: auto.",
      },
      quality: {
        type: "string",
        enum: ["auto", "low", "medium", "high"],
        description: "Image quality. Default: auto.",
      },
      background: {
        type: "string",
        enum: ["auto", "transparent", "opaque"],
        description: "Background mode. Default: auto.",
      },
      output_format: {
        type: "string",
        enum: ["png", "jpeg", "webp"],
        description: "Image file format. Default: png.",
      },
      use_identity_reference: {
        type: "boolean",
        description: "Use the canonical identity image configured by the user. Required whenever generating the agent itself. Default: false.",
      },
      reference_images: {
        type: "array",
        items: { type: "string" },
        maxItems: MAX_REFERENCE_IMAGES,
        description: "Optional local image paths under workspace/attachments/ to use as visual references.",
      },
      input_fidelity: {
        type: "string",
        enum: ["low", "high"],
        description: "How strongly to preserve input image details. Default: high when references are used.",
      },
    },
    required: ["prompt"],
  },
  execute: async (args) => {
    const { llm, image_generation: imageGenerationConfig } = loadConfig();
    const model = llm.currentModel;
    if (!isGptModel(model)) {
      return `Error: image_gen is only available with a GPT model; active model is ${model}`;
    }

    const prompt = String(args.prompt ?? "").trim();
    if (!prompt) return "Error: prompt is required";

    const size = (args.size ?? "auto") as ImageSize;
    const quality = (args.quality ?? "auto") as ImageQuality;
    const background = (args.background ?? "auto") as ImageBackground;
    const outputFormat = (args.output_format ?? "png") as ImageFormat;
    const inputFidelity = (args.input_fidelity ?? "high") as InputFidelity;
    const useIdentityReference = args.use_identity_reference === true;
    const explicitReferences = Array.isArray(args.reference_images)
      ? args.reference_images.map(String).filter(Boolean)
      : [];
    const configuredIdentity = imageGenerationConfig.identity_reference_path.trim();
    if (useIdentityReference && !configuredIdentity) {
      return "Error: use_identity_reference was requested but image_generation.identity_reference_path is not configured";
    }

    const requestedReferences = [
      ...(useIdentityReference ? [configuredIdentity] : []),
      ...explicitReferences,
    ];
    const uniqueReferences = [...new Set(requestedReferences)];
    if (uniqueReferences.length > MAX_REFERENCE_IMAGES) {
      return `Error: at most ${MAX_REFERENCE_IMAGES} reference images are supported`;
    }
    const references = uniqueReferences.map(referenceDataUrl);
    const baseUrl = (llm.base_url || "https://api.openai.com/v1").replace(/\/$/, "");
    const inputContent: Array<Record<string, unknown>> = [{
      type: "input_text",
      text: `Generate the requested image. Return the image and a very brief confirmation.\n\n${prompt}`,
    }];
    for (const reference of references) {
      inputContent.push({ type: "input_image", image_url: reference.dataUrl, detail: "high" });
    }

    const imageTool: Record<string, unknown> = {
      type: "image_generation",
      size,
      quality,
      background,
      output_format: outputFormat,
    };
    if (references.length > 0) {
      imageTool.action = "edit";
      if (!/gpt-image-2-codex/i.test(model)) imageTool.input_fidelity = inputFidelity;
    }

    const res = await fetch(`${baseUrl}/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${llm.api_key}`,
      },
      body: JSON.stringify({
        model,
        input: [{ role: "user", content: inputContent }],
        tools: [imageTool],
        tool_choice: { type: "image_generation" },
      }),
    });

    if (!res.ok) {
      const detail = (await res.text()).slice(0, 1200);
      throw new Error(`Image generation API ${res.status}: ${detail}`);
    }

    const data = await res.json() as { output?: ImageGenerationCall[] };
    const calls = (data.output ?? []).filter(
      item => item.type === "image_generation_call" && typeof item.result === "string" && item.result.length > 0,
    );
    if (calls.length === 0) throw new Error("Image generation completed without an image result");

    mkdirSync(ATTACHMENTS_DIR, { recursive: true });
    const files: string[] = [];
    for (const call of calls) {
      const format = call.output_format === "jpeg" || call.output_format === "webp" ? call.output_format : outputFormat;
      const ext = format === "jpeg" ? "jpg" : format;
      const filename = `generated-${Date.now()}-${randomBytes(4).toString("hex")}.${ext}`;
      const filePath = join(ATTACHMENTS_DIR, filename);
      writeFileSync(filePath, Buffer.from(call.result!, "base64"));
      queueAttachment(filePath);
      files.push(filePath);
      logger.info({ filePath, model, format, references: references.map(ref => ref.path) }, "generated image saved and queued");
    }

    return JSON.stringify({
      success: true,
      images: files,
      revised_prompt: calls[0].revised_prompt,
      references_used: references.map(reference => reference.path),
      identity_reference_used: useIdentityReference,
    });
  },
};
