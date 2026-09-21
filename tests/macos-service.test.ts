import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
import { serviceDefinition, shellQuote } from "../scripts/macos-service.js";

it("pipes selected text as data without replacing the selection", () => {
  const { info, workflow } = serviceDefinition(
    "exec '/some/node' '/some/service.js' '/some/config.json'",
  );
  expect(info.NSServices[0].NSSendTypes).toEqual(["NSStringPboardType"]);
  expect(info.NSServices[0]).not.toHaveProperty("NSReturnTypes");
  expect(workflow.actions[0].action.ActionParameters.inputMethod).toBe(0);
  expect(workflow.workflowMetaData.serviceOutputTypeIdentifier).toBe("com.apple.Automator.nothing");
});

it("quotes installation paths without executing shell metacharacters", () => {
  const path = "/Users/a'b/My $(echo unsafe) `echo unsafe`/capture.js";
  expect(
    execFileSync("/bin/sh", ["-c", `printf '%s' ${shellQuote(path)}`], { encoding: "utf8" }),
  ).toBe(path);
});
