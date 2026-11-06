// Talks to TrueForge through its TypeScript SDK. Moon never calls a model provider:
// everything model-related goes through TrueForge.
//
// Phase 0: check that TrueForge is reachable and list the models configured in it.
// Sessions, turns and streaming are added in later phases.

import { TrueForge, TrueForgeError, TrueForgeTimeoutError } from "@truefoundry/trueforge-sdk";
import type { ModelRef, MoonConfig } from "../shared/config.js";

/** One model as configured in TrueForge. */
export interface ModelInfo {
  /** Provider name in TrueForge, e.g. "anthropic". */
  provider: string;
  /** Model name in TrueForge, e.g. "claude-sonnet-5-5". */
  name: string;
  /** "provider/name", the form used to pick a model for a session. */
  ref: string;
  /** Identifier TrueForge sends to the provider (may differ from name). */
  modelId: string;
  /** Context window in tokens, when TrueForge knows it. */
  contextLength?: number;
  /** Maximum output tokens, when TrueForge knows it. */
  maxOutputTokens?: number;
}

export type ConnectionStatus =
  | { state: "connected"; models: ModelInfo[] }
  /** Nothing answered at the TrueForge URL (not started, wrong port, or timed out). */
  | { state: "unreachable"; message: string }
  /** TrueForge answered, but with an error. */
  | { state: "error"; message: string; statusCode?: number };

/** Result of "Moon: Check setup". */
export interface SetupReport {
  baseUrl: string;
  status: ConnectionStatus;
  /** The main/backup models from Moon's config, and whether TrueForge has each one. */
  configuredModels: Array<{ role: "main" | "backup"; ref: string; found: ModelInfo | undefined }>;
}

export const modelRef = (m: ModelRef): string => `${m.provider}/${m.model}`;

export class TrueForgeClient {
  /** The SDK client, for the session and registration modules. */
  readonly sdk: TrueForge;

  constructor(private readonly settings: MoonConfig["trueforge"]) {
    this.sdk = new TrueForge({
      baseUrl: settings.baseUrl,
      timeoutInSeconds: settings.requestTimeoutMs / 1000,
      // A status check must answer quickly; retries would only delay "not reachable".
      maxRetries: 0,
    });
  }

  /** Lists every model configured in TrueForge. Throws the SDK's errors. */
  async listModels(): Promise<ModelInfo[]> {
    const response = await this.sdk.settings.modelProviders.list();
    return response.data.flatMap((provider) =>
      provider.manifest.models.map((model) => ({
        provider: provider.name,
        name: model.name,
        ref: `${provider.name}/${model.name}`,
        modelId: model.modelId,
        contextLength: model.properties.contextLength,
        maxOutputTokens: model.properties.maxOutputTokens,
      })),
    );
  }

  /** Never throws: turns every failure into a status the UI can show. */
  async checkConnection(): Promise<ConnectionStatus> {
    try {
      return { state: "connected", models: await this.listModels() };
    } catch (err) {
      return describeFailure(err, this.settings.baseUrl);
    }
  }

  /** Connection status plus whether the main and backup models from config exist in TrueForge. */
  async checkSetup(models: MoonConfig["models"]): Promise<SetupReport> {
    const status = await this.checkConnection();
    const available = status.state === "connected" ? status.models : [];
    const configuredModels = (["main", "backup"] as const).map((role) => {
      const ref = modelRef(models[role]);
      return { role, ref, found: available.find((m) => m.ref === ref) };
    });
    return { baseUrl: this.settings.baseUrl, status, configuredModels };
  }
}

function describeFailure(err: unknown, baseUrl: string): ConnectionStatus {
  if (err instanceof TrueForgeTimeoutError) {
    return { state: "unreachable", message: `No answer from TrueForge at ${baseUrl} (timed out).` };
  }
  if (err instanceof TrueForgeError && err.statusCode === undefined) {
    // No HTTP status: the request never got an answer (connection refused, DNS, ...).
    return { state: "unreachable", message: `Cannot connect to TrueForge at ${baseUrl}. Is it running?` };
  }
  if (err instanceof TrueForgeError) {
    return {
      state: "error",
      statusCode: err.statusCode,
      message: `TrueForge answered with HTTP ${err.statusCode}: ${err.message}`,
    };
  }
  return { state: "error", message: `Unexpected error talking to TrueForge: ${(err as Error).message}` };
}
