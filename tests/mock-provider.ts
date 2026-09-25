import { createServer } from "node:http";

export function mockProvider() {
  return createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.headers.authorization !== "Bearer test-key") {
      response.writeHead(401);
      response.end(JSON.stringify({ error: { message: "Rejected test-key" } }));
      return;
    }
    if (request.url === "/v1/models") {
      response.end(
        JSON.stringify({
          object: "list",
          data: [
            { id: "test-model", object: "model" },
            { id: "unsupported-model", object: "model" },
          ],
        }),
      );
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    if (input.model === "unsupported-model") {
      response.writeHead(400);
      response.end(JSON.stringify({ error: { message: "Unsupported schema" } }));
      return;
    }
    if (input.tool_choice?.name === "read_validation_value") {
      response.end(
        JSON.stringify({
          id: "resp_tool",
          object: "response",
          status: "completed",
          output: [
            {
              type: "function_call",
              call_id: "call_probe",
              name: "read_validation_value",
              arguments: "{}",
            },
          ],
        }),
      );
      return;
    }
    if (input.text.format.name === "tool_validation") {
      const result = input.input.find(
        (item: { type?: string }) => item.type === "function_call_output",
      );
      response.end(
        JSON.stringify({
          id: "resp_validation",
          object: "response",
          status: "completed",
          output: [
            {
              type: "message",
              id: "msg_validation",
              status: "completed",
              role: "assistant",
              content: [{ type: "output_text", text: result.output, annotations: [] }],
            },
          ],
        }),
      );
      return;
    }
    const payload = JSON.parse(
      typeof input.input === "string" ? input.input : input.input[0].content,
    );
    if (input.text.format.name === "project_summary" && input.input.length === 1) {
      response.end(
        JSON.stringify({
          id: "resp_discovery",
          object: "response",
          status: "completed",
          output: [
            {
              type: "function_call",
              call_id: "call_readme",
              name: "read_file",
              arguments: JSON.stringify({ scope: "repository", path: "README.md", offset: 0 }),
            },
          ],
        }),
      );
      return;
    }
    const explicitNote = payload.capture === "note: I prefer browser-tested atomic commits.";
    const implicitNote =
      payload.capture === "My browser-test review preference is a short summary.";
    let output: unknown =
      input.text.format.name === "capture_interpretation"
        ? {
            title: payload.capture,
            prompt: `Implement: ${payload.capture}`,
            sources: [],
            kind: explicitNote || implicitNote ? "note" : "idea",
            project:
              payload.capture === "Implement project search in T3 Code" ? "example-project" : "",
            dueDate: null,
            priority: "normal",
            relatedId: null,
            rationale: "Test interpretation",
            needsClarification: false,
            clarificationQuestions: [],
            updateProfile: explicitNote,
            referenceIds: payload.context.candidates
              .filter((alias: { available: boolean }) => alias.available)
              .map((alias: { id: string }) => alias.id),
          }
        : { answer: "Connection works.", sources: [] };
    if (
      input.text.format.name === "capture_interpretation" &&
      payload.capture === "Plan the demo with Benjamin"
    ) {
      const answers = payload.context.previousRefinement?.clarifications ?? [];
      const project = answers.find(
        (entry: { question: string; answer: string }) =>
          entry.question === "Which project is this demo for?" && entry.answer,
      )?.answer;
      const person = answers.find(
        (entry: { question: string; answer: string }) =>
          entry.question === "Which Benjamin do you mean?" && entry.answer,
      )?.answer;
      const questions = [
        !project && "Which project is this demo for?",
        !person && "Which Benjamin do you mean?",
      ].filter(Boolean);
      output = {
        ...(output as object),
        prompt: `Plan the ${project || "unspecified project"} demo with ${person || "Benjamin (identity needed)"}.`,
        needsClarification: questions.length > 0,
        clarificationQuestions: questions,
        rationale: questions.length
          ? "The project and person need to be clear."
          : "The demo is ready to plan.",
      };
    }
    if (input.text.format.name === "profile_update") {
      const path = "browser-test-preferences.md";
      const existing = payload.documents.find((doc: { path: string }) => doc.path === path);
      const index = payload.documents.find((doc: { path: string }) => doc.path === "index.md");
      const content = `${existing?.content ?? "---\ntype: Working rules\ntitle: Browser test preferences\n---\n\n# Browser test preferences\n"}\n${payload.capture.body}\n`;
      output = {
        decision: "apply",
        summary: "Saved your browser test preference.",
        paths: [path],
        changes: [
          { path, content },
          ...(!existing
            ? [
                {
                  path: index.path,
                  content: `${index.content}\n- [Browser test preferences](${path})\n`,
                },
              ]
            : []),
        ],
      };
    }
    if (input.text.format.name === "project_summary") {
      const evidence = input.input.find(
        (item: { type?: string }) => item.type === "function_call_output",
      );
      output = {
        summary: "## Purpose\nA project for team onboarding\n\n## Sources\n- README.md",
        sources: ["repository/README.md"],
        complete: !!JSON.parse(evidence.output).content,
      };
    }
    response.end(
      JSON.stringify({
        id: "resp_test",
        object: "response",
        created_at: 0,
        status: "completed",
        model: "test-model",
        output: [
          {
            type: "message",
            id: "msg_test",
            status: "completed",
            role: "assistant",
            content: [{ type: "output_text", text: JSON.stringify(output), annotations: [] }],
          },
        ],
      }),
    );
  });
}
