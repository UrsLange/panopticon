import { assert } from "vitest";
import type {
  Assistant,
  AssistantContext,
  RefinementContext,
} from "../server/application/assistant.js";
import type { Refinement } from "../shared/schema.js";

export type Draft = Partial<Refinement>;
type ReferenceEvidence = Pick<AssistantContext, "candidates" | "people"> & {
  profileDocuments: string[];
};
export function refinementAgent(
  draft: (text: string, context: RefinementContext & ReferenceEvidence) => Promise<Draft>,
): Assistant["interpret"] {
  return async (text, context, tools) => {
    const references = tools.find((tool) => tool.name === "get_reference_candidates");
    assert(references);
    const { data } = await references.execute(
      { id: context.capture.id },
      new AbortController().signal,
    );
    const result = await draft(text, { ...context, ...(data as ReferenceEvidence) });
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
    const complete = tools.find((tool) => tool.name === "complete_refinement");
    assert(complete);
    await complete.execute({ ctxAssessment: null }, new AbortController().signal);
  };
}
