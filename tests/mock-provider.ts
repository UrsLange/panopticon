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
    if (
      input.tools?.some((tool: { name?: string }) =>
        ["complete_note", "complete_project_review"].includes(tool.name ?? ""),
      )
    ) {
      const workspace = JSON.parse(input.input[0].content);
      const results = input.input
        .filter((item: { type: string }) => item.type === "function_call_output")
        .map((item: { output: string }) => JSON.parse(item.output));
      const step = results.length;
      const project = !!workspace.artifactPaths["project.json"];
      let call: { name: string; args: unknown } | undefined;
      if (step === 0)
        call = {
          name: "read_file",
          args: {
            path: workspace.artifactPaths[project ? "project.json" : "note.json"],
            startLine: null,
            endLine: null,
          },
        };
      else if (project) {
        const artifact = JSON.parse(results[0].content);
        if (step === 1)
          call = {
            name: "read_repository_file",
            args: { scope: "repository", path: "README.md", offset: 0 },
          };
        if (step === 2)
          call = {
            name: "read_file",
            args: { path: artifact.documentPath, startLine: null, endLine: null },
          };
        if (step === 3)
          call = {
            name: "write_file",
            args: {
              path: artifact.documentPath,
              content: results[2].content.replace(
                /<!-- project-summary:start -->[\s\S]*?<!-- project-summary:end -->/,
                "<!-- project-summary:start -->\n## Purpose\nA project for team onboarding\n\n## Sources\n- README.md\n<!-- project-summary:end -->",
              ),
            },
          };
        if (step === 4) call = { name: "check_profile", args: {} };
        if (step === 5)
          call = {
            name: "commit_profile",
            args: {
              summary: "refresh project knowledge",
              body: "Update the relevant profile knowledge using verified evidence.",
            },
          };
        if (step === 6)
          call = { name: "complete_project_review", args: { sources: ["repository/README.md"] } };
      } else {
        const path = "browser-test-preferences.md";
        const artifact = JSON.parse(results[0].content);
        if (step === 1) call = { name: "list_profile_files", args: {} };
        if (step === 2)
          call = {
            name: "read_file",
            args: {
              path: results[1].files.includes(path) ? path : "index.md",
              startLine: null,
              endLine: null,
            },
          };
        if (step === 3)
          call = {
            name: "write_file",
            args: {
              path,
              content: `${results[1].files.includes(path) ? results[2].content : "---\ntype: Working rules\ntitle: Browser test preferences\n---\n\n# Browser test preferences\n"}\n${artifact.capture.body}\n`,
            },
          };
        if (step === 4)
          call = results[1].files.includes(path)
            ? { name: "check_profile", args: {} }
            : {
                name: "write_file",
                args: {
                  path: "index.md",
                  content: `${results[2].content}\n- [Browser test preferences](${path})\n`,
                },
              };
        if (step === 5)
          call = {
            name: "commit_profile",
            args: {
              summary: "incorporate profile note",
              body: "Update the relevant profile knowledge using verified evidence.",
            },
          };
        if (step === 6) call = { name: "complete_note", args: { paths: [path] } };
      }
      response.end(
        JSON.stringify({
          id: `resp_edit_${step}`,
          object: "response",
          status: "completed",
          output: call
            ? [
                {
                  type: "function_call",
                  id: `fc_edit_${step}`,
                  call_id: `edit_${step}`,
                  name: call.name,
                  arguments: JSON.stringify(call.args),
                },
              ]
            : [
                {
                  type: "message",
                  id: "msg_edit",
                  role: "assistant",
                  status: "completed",
                  content: [
                    {
                      type: "output_text",
                      text: project
                        ? "Updated project knowledge."
                        : "Saved your browser test preference.",
                      annotations: [],
                    },
                  ],
                },
              ],
        }),
      );
      return;
    }
    const refining = input.tools?.some(
      (tool: { name?: string }) => tool.name === "save_refinement",
    );
    if (refining) {
      input.input = input.input.slice(
        input.input.findLastIndex((entry: { role?: string }) => entry.role === "user"),
      );
      const calls = input.input.filter(
        (entry: { type?: string }) => entry.type === "function_call",
      );
      const results = input.input.filter(
        (entry: { type?: string }) => entry.type === "function_call_output",
      );
      if (!results.length) {
        const { context } = JSON.parse(input.input[0].content);
        response.end(
          JSON.stringify({
            id: "resp_references",
            object: "response",
            status: "completed",
            output: [
              {
                type: "function_call",
                id: "fc_references",
                call_id: "references",
                name: "get_reference_candidates",
                arguments: JSON.stringify({ id: context.capture.id }),
              },
            ],
          }),
        );
        return;
      }
      if (calls.at(-1)?.name !== "get_reference_candidates") {
        const last = JSON.parse(results.at(-1).output);
        const incorporate =
          calls.at(-1)?.name === "save_refinement" &&
          last.kind === "note" &&
          !last.clarifications.some((q: { resolved: boolean }) => !q.resolved);
        response.end(
          JSON.stringify({
            id: "resp_refined",
            object: "response",
            status: "completed",
            output: incorporate
              ? [
                  {
                    type: "function_call",
                    id: "fc_note",
                    call_id: "note",
                    name: "incorporate_note",
                    arguments: JSON.stringify({ id: last.id }),
                  },
                ]
              : [
                  {
                    type: "function_call",
                    id: "fc_complete",
                    call_id: "complete",
                    name: "complete_refinement",
                    arguments: JSON.stringify({ ctxAssessment: null }),
                  },
                ],
          }),
        );
        return;
      }
      input.text = { format: { name: "capture_interpretation" } };
    }
    if (input.tools?.some((tool: { name?: string }) => tool.name === "list_profile_files")) {
      const workspace = JSON.parse(input.input[0].content);
      const results = input.input
        .filter((item: { type: string }) => item.type === "function_call_output")
        .map((item: { output: string }) => JSON.parse(item.output));
      const step = results.length;
      const path = "partner-enablement.md";
      const statement = "My team now owns partner enablement.";
      let call: { name: string; args: unknown } | null = null;
      let summary = "No new profile knowledge to retain.";
      if (step === 0)
        call = {
          name: "read_file",
          args: { path: workspace.activityPath, startLine: null, endLine: null },
        };
      else if (
        JSON.parse(results[0].content).activity.some((event: { evidence: unknown }) =>
          JSON.stringify(event.evidence).includes(statement),
        )
      ) {
        if (step === 1) call = { name: "list_profile_files", args: {} };
        else if (!results[1].files.includes(path)) {
          if (step === 2)
            call = {
              name: "read_file",
              args: { path: "index.md", startLine: null, endLine: null },
            };
          if (step === 3)
            call = {
              name: "write_file",
              args: {
                path,
                content: `---\ntype: Team\ntitle: Partner enablement\ndescription: Team responsibility\n---\n\n${statement}\n`,
              },
            };
          if (step === 4)
            call = {
              name: "write_file",
              args: {
                path: "index.md",
                content: `${results[2].content}\n- [Partner enablement](${path})\n`,
              },
            };
          if (step === 5) call = { name: "profile_diff", args: {} };
          if (step === 6) call = { name: "check_profile", args: {} };
          if (step === 7)
            call = {
              name: "commit_profile",
              args: {
                summary: "consolidate daily activity",
                body: "Update the relevant profile knowledge using verified evidence.",
              },
            };
          if (step === 8) summary = "Recorded the team's partner enablement responsibility.";
        }
      }
      response.end(
        JSON.stringify({
          id: `resp_learning_${step}`,
          object: "response",
          status: "completed",
          output: call
            ? [
                {
                  type: "function_call",
                  id: `fc_learning_${step}`,
                  call_id: `learning_${step}`,
                  name: call.name,
                  arguments: JSON.stringify(call.args),
                  status: "completed",
                },
              ]
            : [
                {
                  type: "message",
                  id: "msg_learning",
                  role: "assistant",
                  status: "completed",
                  content: [{ type: "output_text", text: summary, annotations: [] }],
                },
              ],
        }),
      );
      return;
    }
    if (
      input.tool_choice === "auto" &&
      input.tools?.some((tool: { name?: string }) => tool.name === "read_validation_value")
    ) {
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
    const explicitNote = payload.capture === "note: I prefer browser-tested atomic commits.";
    const implicitNote =
      payload.capture === "My browser-test review preference is a short summary.";
    let output: unknown =
      input.text.format.name === "capture_interpretation"
        ? {
            title: payload.capture,
            prompt: `Implement: ${payload.capture}`,
            sources: [],
            kind:
              explicitNote || implicitNote
                ? "note"
                : payload.capture.startsWith("Implement ")
                  ? "commitment"
                  : "idea",
            project:
              payload.capture === "Implement project search in T3 Code" ? "example-project" : "",
            dueDate: null,
            priority: "normal",
            relatedId: null,
            rationale: "Test interpretation",
            needsClarification: false,
            clarificationQuestions: [],
            updateProfile: explicitNote,
            referenceIds: JSON.parse(
              input.input.find(
                (entry: { type?: string; call_id?: string }) =>
                  entry.type === "function_call_output" && entry.call_id === "references",
              ).output,
            )
              .candidates.filter((alias: { available: boolean }) => alias.available)
              .map((alias: { id: string }) => alias.id),
          }
        : { answer: "Connection works.", sources: [] };
    if (
      input.text.format.name === "capture_interpretation" &&
      payload.capture === "Plan the demo with Benjamin"
    ) {
      const answers = payload.context.capture.clarifications;
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
    response.end(
      JSON.stringify({
        id: "resp_test",
        object: "response",
        created_at: 0,
        status: "completed",
        model: "test-model",
        output: refining
          ? [
              {
                type: "function_call",
                id: "fc_save",
                call_id: "save",
                name: "save_refinement",
                arguments: JSON.stringify({
                  ...(output as object),
                  id: payload.context.capture.id,
                  execution: payload.capture.startsWith("Implement ") ? "implementation" : "manual",
                  noProject: payload.context.capture.noProject,
                }),
              },
            ]
          : [
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
