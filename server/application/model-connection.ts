import type { Assistant } from "./assistant.js";
import type { Connection } from "./connection.js";

export interface ModelAccess {
  credentials(input?: Connection): Connection;
  saveValidated(input: Connection, baseURL: string): void;
}
export interface ModelProvider {
  models(credentials: Connection): Promise<string[]>;
  assistant(credentials: Connection): Assistant | null;
  validateTools(credentials: Connection): Promise<void>;
  errorMessage(error: unknown, validation?: boolean): string;
}
export function createModelConnection(access: ModelAccess, provider: ModelProvider) {
  return {
    async discover(input?: Connection) {
      const credentials = access.credentials(input);
      try {
        return await provider.models(credentials);
      } catch (error) {
        throw new Error(provider.errorMessage(error));
      }
    },
    async connect(input: Connection) {
      const credentials = access.credentials(input);
      if (!input.model) throw new Error("Choose a model first.");
      try {
        const assistant = provider.assistant(credentials);
        if (!assistant) throw new Error("Missing credentials");
        await provider.validateTools(credentials);
        const context = {
          candidates: [],
          references: [],
          people: null,
          today: "2026-01-01",
          profile: { directory: [], documents: [] },
          related: [],
          commitments: { date: "2026-01-01", due: [], suggested: [], waiting: [] },
        };
        await assistant.ask("Reply briefly that the connection works.", context, [], "");
      } catch (error) {
        throw new Error(provider.errorMessage(error, true));
      }
      access.saveValidated(input, credentials.baseURL);
    },
  };
}
