import { assert } from "vitest";
import type { Assistant, AssistantContext } from "../server/application/assistant.js";
import type { Refinement } from "../shared/schema.js";

export type Draft = Partial<Refinement>;
export function refinementAgent(
  draft: (text: string, context: AssistantContext) => Promise<Draft>,
): Assistant["interpret"] {
  return async (text, context, tools) => {
    const result = await draft(text, context);
    const save = tools.find((tool) => tool.name === "save_refinement");
    assert(save);
    const value = {
      id: context.capture?.id,
      title: text || "Capture",
      kind: "idea",
      execution: "manual",
      project: "",
      noProject: context.capture?.noProject ?? false,
      dueDate: null,
      priority: "normal",
      relatedId: null,
      prompt: text || "Refined content",
      sources: [],
      referenceIds: [],
      clarificationQuestions: [],
      ...result,
    };
    await save.execute(value, new AbortController().signal);
    if (value.kind === "note" && !value.clarificationQuestions.length && !context.referencesOnly) {
      const incorporate = tools.find((tool) => tool.name === "incorporate_note");
      assert(incorporate);
      await incorporate.execute({ id: value.id }, new AbortController().signal);
    }
  };
}
