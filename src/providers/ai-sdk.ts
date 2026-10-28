import { generateText, type LanguageModel } from "ai";
import type { GenerateRequest, GenerateResponse, Provider } from "./types.js";

/**
 * Adapts any Vercel AI SDK provider to the promptdiff Provider interface.
 * Retries are disabled here (maxRetries: 0) because the runner owns retry/backoff.
 */
export class AiSdkProvider implements Provider {
  constructor(
    readonly id: string,
    private readonly getModel: (modelId: string) => LanguageModel,
  ) {}

  async generate(req: GenerateRequest): Promise<GenerateResponse> {
    const result = await generateText({
      model: this.getModel(req.model),
      instructions: req.system,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      // Only send sampling params the user asked for; some models reject them.
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.maxOutputTokens !== undefined ? { maxOutputTokens: req.maxOutputTokens } : {}),
      maxRetries: 0,
      abortSignal: req.signal,
    });
    return {
      text: result.text,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
    };
  }
}
