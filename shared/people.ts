import { z } from "zod";

export const peopleColumns = [
  "prename",
  "lastname",
  "email",
  "role",
  "team",
  "unit",
  "subdivision",
  "division",
  "company",
] as const;
export const entraSchema = z
  .object({
    enabled: z.boolean(),
    authMode: z.enum(["azure-cli", "client-secret"]),
    tenantId: z.string().uuid(),
    clientId: z.union([z.string().uuid(), z.literal("")]),
    clientSecret: z.string().max(8000).optional(),
    myEmail: z
      .string()
      .trim()
      .email()
      .max(320)
      .transform((value) => value.toLowerCase()),
  })
  .superRefine((value, ctx) => {
    if (value.authMode === "client-secret" && !value.clientId)
      ctx.addIssue({
        code: "custom",
        path: ["clientId"],
        message: "Enter an application client ID.",
      });
  });
export type EntraConfig = z.infer<typeof entraSchema>;
export type PublicEntraConfig = Omit<EntraConfig, "clientSecret"> & { hasClientSecret: boolean };
export const defaultEntra: PublicEntraConfig = {
  enabled: false,
  authMode: "azure-cli",
  tenantId: "",
  clientId: "",
  myEmail: "",
  hasClientSecret: false,
};
export type Person = Record<(typeof peopleColumns)[number], string>;
export type OrganizationLevel = "company" | "division" | "subdivision" | "unit" | "team";
export type PersonRelationship = {
  email: string;
  isSelf: boolean;
  shared: Record<OrganizationLevel, boolean | null>;
  closestShared: OrganizationLevel | null;
  leadsUserAt: OrganizationLevel[];
  userLeadsAt: OrganizationLevel[];
};
export type PeopleContext = {
  source: "people";
  syncedAt: string;
  self: Person | null;
  candidates: Person[];
  totalMatches: number;
  searchTruncated: boolean;
  relationships: PersonRelationship[];
};
export type PeopleSyncStatus = {
  warnings: string[];
  running: boolean;
  lastAttempt: string | null;
  lastSuccess: string | null;
  count: number;
  skipped: number;
  error: string | null;
};
