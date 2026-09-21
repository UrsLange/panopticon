import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

if (process.argv[2] === "models") {
  console.log("test/test-model");
} else {
  for await (const _chunk of process.stdin) {
  }
  const mode = process.env.PA_TEST_OPENCODE_MODE;
  if (mode === "provider") {
    console.log(
      JSON.stringify({
        type: "error",
        sessionID: "ses_test",
        error: {
          data: {
            statusCode: 503,
            message: "sensitive-provider-body",
            responseBody: "sensitive-provider-body",
          },
        },
      }),
    );
    process.exit(0);
  }
  if (mode === "process") process.exit(7);
  if (mode === "invalid") {
    console.log("{broken");
    process.exit(0);
  }
  if (mode === "incomplete") process.exit(0);
  const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);
  const rules = config.agent["profile-discovery"].permission;
  if (rules["*"] !== "deny" || rules.edit["*"] !== "deny") process.exit(1);
  const repository = process.argv[process.argv.indexOf("--dir") + 1];
  const document = resolve(
    repository,
    Object.keys(rules.edit).find((path) => path !== "*"),
  );
  const content = readFileSync(document, "utf8");
  for (const filePath of [document, resolve(repository, "README.md")]) {
    console.log(
      JSON.stringify({
        type: "tool_use",
        sessionID: "ses_test",
        part: { tool: "read", state: { status: "completed", input: { filePath } } },
      }),
    );
  }
  if (mode === "stream") await new Promise((resolve) => setTimeout(resolve, 200));
  writeFileSync(
    document,
    content
      .replace(
        /<!-- project-summary:start -->[\s\S]*?<!-- project-summary:end -->/,
        "<!-- project-summary:start -->\n## Purpose\nA project for team onboarding\n\n## Sources\n- README.md\n<!-- project-summary:end -->",
      )
      .replace(/\n\n$/, "\n"),
  );
  console.log(JSON.stringify({ type: "step_finish", part: { reason: "stop" } }));
}
