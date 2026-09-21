import { z } from "zod";

export const connectionSchema = z.object({
  baseURL: z
    .string()
    .url()
    .refine((value) => {
      const url = new URL(value);
      return (
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        (url.protocol === "https:" ||
          (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)))
      );
    }, "Use HTTPS, or HTTP on localhost, without credentials or query parameters."),
  apiKey: z.string().trim().max(8000).optional(),
  model: z.string().trim().max(300).default(""),
});
export type Connection = z.infer<typeof connectionSchema>;
