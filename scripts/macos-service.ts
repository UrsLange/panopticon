import { randomUUID } from "node:crypto";

export function serviceDefinition(command: string) {
  return {
    info: {
      CFBundleIdentifier: "local.personal-assistant.capture-service",
      NSServices: [
        {
          NSMenuItem: { default: "Add to My Mind" },
          NSMessage: "runWorkflowAsService",
          NSSendTypes: ["NSStringPboardType"],
          NSRequiredContext: {},
          NSSendFileTypes: [],
        },
      ],
    },
    workflow: {
      AMApplicationBuild: "521.1",
      AMApplicationVersion: "2.10",
      AMDocumentVersion: "2",
      actions: [
        {
          action: {
            AMAccepts: { Container: "List", Optional: false, Types: ["com.apple.cocoa.string"] },
            AMProvides: { Container: "List", Types: ["com.apple.cocoa.string"] },
            AMActionVersion: "2.0.3",
            AMApplication: ["Automator"],
            ActionBundlePath: "/System/Library/Automator/Run Shell Script.action",
            ActionName: "Run Shell Script",
            ActionParameters: {
              COMMAND_STRING: command,
              CheckedForUserDefaultShell: true,
              inputMethod: 0,
              shell: "/bin/sh",
              source: "",
            },
            BundleIdentifier: "com.apple.RunShellScript",
            CFBundleVersion: "2.0.3",
            CanShowSelectedItemsWhenRun: false,
            CanShowWhenRun: true,
            "Class Name": "RunShellScriptAction",
            UUID: randomUUID(),
            InputUUID: randomUUID(),
            OutputUUID: randomUUID(),
            Category: ["AMCategoryUtilities"],
            UnlocalizedApplications: ["Automator"],
            isViewVisible: true,
            arguments: {},
          },
          isViewVisible: true,
        },
      ],
      connectors: {},
      workflowMetaData: {
        workflowTypeIdentifier: "com.apple.Automator.servicesMenu",
        serviceInputTypeIdentifier: "com.apple.Automator.text",
        serviceOutputTypeIdentifier: "com.apple.Automator.nothing",
        serviceProcessesInput: 0,
      },
    },
  };
}

export function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
