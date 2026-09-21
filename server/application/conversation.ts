import type { Assistant } from "./assistant.js";
import type { createContext } from "./context.js";
import { ApplicationError } from "./errors.js";
import type { ConversationHistory } from "./ports.js";
export function createConversation({
  store,
  getAssistant,
  context,
  searchSessions,
}: {
  store: ConversationHistory;
  getAssistant: () => Assistant | null;
  context: ReturnType<typeof createContext>;
  searchSessions: (query: string) => Promise<string>;
}) {
  return {
    messages: () => store.messages(),
    async ask(text: string, sessionEvidence: string) {
      const assistant = getAssistant();
      if (!assistant)
        throw new ApplicationError(
          "unavailable",
          "Connect and validate a model in Settings to chat.",
        );
      const history = store.messages().slice(-12);
      const result = await assistant.ask(
        text,
        context(
          text,
          history.filter((message) => message.role === "user").map((message) => message.content),
        ),
        history,
        sessionEvidence,
      );
      store.addMessage("user", text);
      store.addMessage("assistant", result.answer, result.sources);
      return result;
    },
    async search(query: string) {
      try {
        return { evidence: await searchSessions(query) };
      } catch {
        throw new ApplicationError(
          "unavailable",
          "CTX search is unavailable. Check ctx status in your terminal.",
        );
      }
    },
  };
}
