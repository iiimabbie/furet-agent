import { mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { Tool } from "../../types.js";
import { loadConfig } from "../../config.js";
import { ATTACHMENTS_DIR } from "../../paths.js";
import { queueAttachment } from "../context.js";
import { logger } from "../../logger.js";

type ImageFormat = "png" | "jpeg" | "webp";
type ImageQuality = "low" | "medium" | "high" | "auto";
type ImageSize = "auto" | "1024x1024" | "1536x1024" | "1024x1536";
type ImageBackground = "auto" | "transparent" | "opaque";

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
  description: "Generate an image from a text description and attach it to the final Discord reply. Use this whenever the user asks to create, draw, or generate an image. This tool is available only when the active model is GPT; never claim an image was generated unless this tool returns success.",
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
    },
    required: ["prompt"],
  },
  execute: async (args) => {
    const { llm } = loadConfig();
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
    const baseUrl = (llm.base_url || "https://api.openai.com/v1").replace(/\/$/, "");

    const res = await fetch(`${baseUrl}/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${llm.api_key}`,
      },
      body: JSON.stringify({
        model,
        input: `Generate the requested image. Return the image and a very brief confirmation.\n\n${prompt}`,
        tools: [{
          type: "image_generation",
          size,
          quality,
          background,
          output_format: outputFormat,
        }],
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
      logger.info({ filePath, model, format }, "generated image saved and queued");
    }

    return JSON.stringify({
      success: true,
      images: files,
      revised_prompt: calls[0].revised_prompt,
    });
  },
};
