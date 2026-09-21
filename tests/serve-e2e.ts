import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mockProvider } from "./mock-provider.js";

const bin = mkdtempSync(join(tmpdir(), "pa-fake-cli-"));
process.env.PATH = `${bin}:${process.env.PATH}`;
writeFileSync(
  join(bin, "az"),
  `#!${process.execPath}\nprocess.stdout.write(process.argv.includes("show") ? "11111111-1111-4111-8111-111111111111" : "fixture-graph-token");\n`,
  { mode: 0o700 },
);
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url.startsWith("https://graph.microsoft.com/")) {
    if (new Headers(init?.headers).get("Authorization") !== "Bearer fixture-graph-token")
      return Response.json({ error: "Invalid test token" }, { status: 401 });
    if (new URL(url).pathname === "/v1.0/groups")
      return Response.json({
        value: [
          {
            displayName: "Developer Experience",
            onPremisesSamAccountName: "t_developer_experience",
          },
          { displayName: "Tech", onPremisesSamAccountName: "sd_tech" },
          { displayName: "Technology", onPremisesSamAccountName: "d_technology" },
          { displayName: "Old Unit", onPremisesSamAccountName: "u_old_unit" },
        ],
      });
    return Response.json({
      value: [
        {
          givenName: "Alex",
          surname: "Example",
          mail: "alex@example.com",
          jobTitle: "Product lead",
          userType: "Member",
          accountEnabled: true,
          department: "Developer Experience",
          companyName: "Example",
          employeeOrgData: { division: "Technology" },
          onPremisesDistinguishedName:
            "CN=Alex Example,OU=Developer Experience,OU=Tech,OU=Technology,OU=Example,OU=Organisation,DC=example,DC=com",
        },
        {
          givenName: "Anna",
          surname: "Müller",
          mail: "anna@example.com",
          jobTitle: "Agile Coach",
          userType: "Member",
          accountEnabled: true,
          department: "Developer Experience",
          companyName: "Example",
          employeeOrgData: { division: "Technology" },
          onPremisesDistinguishedName:
            "CN=Anna Müller,OU=Developer Experience,OU=Tech,OU=Technology,OU=Example,OU=Organisation,DC=example,DC=com",
        },
      ],
    });
  }
  if (url.startsWith("https://login.microsoftonline.com/"))
    return Response.json({ access_token: "fixture-graph-token" });
  return originalFetch(input, init);
};
const provider = mockProvider();
await new Promise<void>((resolve) => provider.listen(4320, "127.0.0.1", resolve));
await import("../server/main.js");
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => provider.close());
